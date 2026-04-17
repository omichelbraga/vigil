use super::{CheckResult, CheckStatus, Monitor, async_trait};
use chrono::Utc;
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// How the logfile monitor decides to fire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FireOn {
    /// Fire (Critical) when the regex matches at least once within the window.
    Match,
    /// Fire (Warning) when the regex has matched zero times within the window.
    NoMatchWithin,
}

impl FireOn {
    pub fn parse(s: &str) -> Self {
        match s {
            "no-match-within" | "no_match_within" | "nomatch" => FireOn::NoMatchWithin,
            _ => FireOn::Match,
        }
    }
}

/// Per-file read state keyed by path. Tracks inode (0 on Windows) and last
/// read offset so we can detect rotation (inode change or size < offset) and
/// only scan new bytes on each tick.
#[derive(Debug, Clone, Copy, Default)]
struct FileCursor {
    inode: u64,
    offset: u64,
    /// Unix timestamp (secs) of the last observed match. Used by the
    /// `no-match-within` mode to decide whether to fire.
    last_match_ts: Option<u64>,
}

/// Global pointer table shared across all LogfileMonitor instances. Keying on
/// the absolute path means multiple monitors watching the same file share a
/// cursor (fine in practice — they see the same byte stream).
static CURSORS: Lazy<Mutex<HashMap<String, FileCursor>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Tails a logfile and alerts based on regex matches within a rolling window.
pub struct LogfileMonitor {
    path: String,
    pattern: String,
    fire_on: FireOn,
    window: Duration,
}

impl LogfileMonitor {
    pub fn new(path: String, pattern: String, fire_on: FireOn, window_secs: u64) -> Self {
        Self {
            path,
            pattern,
            fire_on,
            window: Duration::from_secs(window_secs.max(1)),
        }
    }
}

/// Platform-specific inode lookup. On non-Unix we return 0 — inode change is
/// Unix-only; on Windows we fall back to size-shrink detection only.
#[cfg(unix)]
fn file_inode(path: &str) -> std::io::Result<u64> {
    use std::os::unix::fs::MetadataExt;
    let md = std::fs::metadata(path)?;
    Ok(md.ino())
}

#[cfg(not(unix))]
fn file_inode(_path: &str) -> std::io::Result<u64> {
    Ok(0)
}

#[async_trait]
impl Monitor for LogfileMonitor {
    async fn check(&self) -> CheckResult {
        let start = Instant::now();
        let path = self.path.clone();
        let pattern = self.pattern.clone();
        let fire_on = self.fire_on;
        let window = self.window;

        let result = tokio::task::spawn_blocking(move || scan_logfile(&path, &pattern, fire_on, window))
            .await;

        let elapsed = start.elapsed().as_millis() as u64;

        let (status, message, meta) = match result {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => (
                CheckStatus::Unknown,
                e,
                None,
            ),
            Err(e) => (
                CheckStatus::Unknown,
                format!("logfile scan task failed: {e}"),
                None,
            ),
        };

        CheckResult {
            monitor_name: format!("logfile:{}", self.path),
            monitor_type: "logfile".to_string(),
            status,
            message,
            response_time_ms: Some(elapsed),
            metadata: meta,
            timestamp: Utc::now(),
        }
    }
}

fn scan_logfile(
    path: &str,
    pattern: &str,
    fire_on: FireOn,
    window: Duration,
) -> Result<(CheckStatus, String, Option<serde_json::Value>), String> {
    let re = match Regex::new(pattern) {
        Ok(r) => r,
        Err(e) => return Err(format!("invalid regex '{pattern}': {e}")),
    };

    // Stat the file up front so we can detect rotation BEFORE we lock the
    // cursor table (short critical section, no IO while locked).
    let md = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) => return Err(format!("cannot stat '{path}': {e}")),
    };
    let current_size = md.len();
    let current_inode = file_inode(path).unwrap_or(0);

    // Read + update cursor atomically. We clone the HashMap entry out, drop
    // the lock while doing IO, then re-acquire to commit.
    let start_offset: u64;
    let mut last_match_ts: Option<u64>;
    {
        let mut cursors = CURSORS
            .lock()
            .map_err(|e| format!("cursor mutex poisoned: {e}"))?;
        let entry = cursors.entry(path.to_string()).or_default();

        // Rotation detection: inode changed OR file shrunk below our offset.
        // Either way, reset to 0 so we scan from the top of the new file.
        let rotated = (entry.inode != 0 && entry.inode != current_inode)
            || current_size < entry.offset;
        if rotated {
            entry.offset = 0;
        }
        entry.inode = current_inode;
        start_offset = entry.offset;
        last_match_ts = entry.last_match_ts;
    }

    // Open + seek + read new bytes.
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return Err(format!("cannot open '{path}': {e}")),
    };
    let mut reader = BufReader::new(file);
    if start_offset > 0 {
        if let Err(e) = reader.seek(SeekFrom::Start(start_offset)) {
            return Err(format!("seek failed on '{path}': {e}"));
        }
    }

    let mut match_count: u32 = 0;
    let mut sample_line: Option<String> = None;
    let mut bytes_read: u64 = 0;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break, // EOF
            Ok(n) => {
                bytes_read += n as u64;
                let trimmed = line.trim_end_matches(['\n', '\r']);
                if re.is_match(trimmed) {
                    match_count += 1;
                    if sample_line.is_none() {
                        // Cap sample line so we don't stuff a megabyte into an
                        // event payload.
                        let mut s = trimmed.to_string();
                        if s.len() > 512 {
                            s.truncate(512);
                            s.push('…');
                        }
                        sample_line = Some(s);
                    }
                }
            }
            Err(e) => return Err(format!("read error on '{path}': {e}")),
        }
    }

    let new_offset = start_offset + bytes_read;
    let now_ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    if match_count > 0 {
        last_match_ts = Some(now_ts);
    }

    // Commit new cursor state.
    {
        let mut cursors = CURSORS
            .lock()
            .map_err(|e| format!("cursor mutex poisoned: {e}"))?;
        let entry = cursors.entry(path.to_string()).or_default();
        entry.inode = current_inode;
        entry.offset = new_offset;
        entry.last_match_ts = last_match_ts;
    }

    // Decide status.
    let meta = serde_json::json!({
        "path": path,
        "pattern": pattern,
        "match_count": match_count,
        "bytes_scanned": bytes_read,
        "file_size": current_size,
        "sample_line": sample_line,
    });

    let (status, message) = match fire_on {
        FireOn::Match => {
            if match_count > 0 {
                let sample = sample_line.as_deref().unwrap_or("");
                (
                    CheckStatus::Critical,
                    format!(
                        "{} match(es) for /{}/ in {}: {}",
                        match_count, pattern, path, sample
                    ),
                )
            } else {
                (
                    CheckStatus::Ok,
                    format!("no matches for /{}/ in {}", pattern, path),
                )
            }
        }
        FireOn::NoMatchWithin => {
            // Fire if no match has been seen within `window`.
            let window_secs = window.as_secs();
            let fire = match last_match_ts {
                Some(ts) => now_ts.saturating_sub(ts) > window_secs,
                None => true, // never matched since agent start → fire
            };
            if match_count > 0 {
                (
                    CheckStatus::Ok,
                    format!("{} recent match(es) for /{}/ in {}", match_count, pattern, path),
                )
            } else if fire {
                (
                    CheckStatus::Warning,
                    format!(
                        "no match for /{}/ in {} within {}s",
                        pattern, path, window_secs
                    ),
                )
            } else {
                (
                    CheckStatus::Ok,
                    format!(
                        "no new matches but within window for /{}/ in {}",
                        pattern, path
                    ),
                )
            }
        }
    };

    Ok((status, message, Some(meta)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[tokio::test]
    async fn logfile_match_mode_fires_critical_on_match() {
        let path = std::env::temp_dir().join(format!(
            "vigil-logfile-test-{}.log",
            std::process::id()
        ));
        let path_str = path.to_string_lossy().to_string();

        // Write a line containing the trigger word.
        {
            let mut f = std::fs::File::create(&path).expect("create log");
            writeln!(f, "2026-04-16 INFO starting up").unwrap();
            writeln!(f, "2026-04-16 ERROR occurred while parsing config").unwrap();
            f.flush().unwrap();
        }

        let mon = LogfileMonitor::new(path_str.clone(), "ERROR".to_string(), FireOn::Match, 600);
        let r = mon.check().await;

        assert!(
            matches!(r.status, CheckStatus::Critical),
            "expected Critical, got {:?} (msg={})",
            r.status,
            r.message
        );
        assert!(r.message.contains("ERROR"), "message missing ERROR: {}", r.message);

        // Second check on same file with no new bytes → Ok (no new matches).
        let r2 = mon.check().await;
        assert!(
            matches!(r2.status, CheckStatus::Ok),
            "expected Ok on second pass (no new bytes), got {:?}",
            r2.status
        );

        // Cleanup.
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn logfile_missing_file_returns_unknown() {
        let mon = LogfileMonitor::new(
            "/tmp/vigil-definitely-does-not-exist-xyzzy.log".to_string(),
            "ERROR".to_string(),
            FireOn::Match,
            60,
        );
        let r = mon.check().await;
        assert!(matches!(r.status, CheckStatus::Unknown));
    }

    #[tokio::test]
    async fn logfile_invalid_regex_returns_unknown() {
        let path = std::env::temp_dir().join(format!(
            "vigil-logfile-regex-{}.log",
            std::process::id()
        ));
        let path_str = path.to_string_lossy().to_string();
        std::fs::write(&path, b"hello\n").unwrap();

        let mon = LogfileMonitor::new(path_str, "(unclosed".to_string(), FireOn::Match, 60);
        let r = mon.check().await;
        assert!(matches!(r.status, CheckStatus::Unknown));
        assert!(r.message.contains("invalid regex"));

        let _ = std::fs::remove_file(&path);
    }
}
