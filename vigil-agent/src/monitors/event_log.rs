use super::{CheckResult, CheckStatus, Monitor, async_trait};
use chrono::Utc;
use std::time::Instant;

/// Windows Event Log monitor. Queries `wevtutil` for recent events matching
/// a given provider + event_id pair on a channel; fires Critical when the
/// count exceeds zero in the most-recent window.
///
/// On non-Windows platforms this is a stub that always returns Unknown.
pub struct EventLogMonitor {
    channel: String,
    provider: String,
    event_id: u32,
    window_secs: u64,
}

impl EventLogMonitor {
    pub fn new(channel: String, provider: String, event_id: u32, window_secs: u64) -> Self {
        Self {
            channel,
            provider,
            event_id,
            window_secs: window_secs.max(1),
        }
    }

    fn name(&self) -> String {
        format!("event_log:{}/{}/{}", self.channel, self.provider, self.event_id)
    }
}

#[async_trait]
impl Monitor for EventLogMonitor {
    async fn check(&self) -> CheckResult {
        let start = Instant::now();
        let (status, message, meta) = run_event_log_query(
            &self.channel,
            &self.provider,
            self.event_id,
            self.window_secs,
        )
        .await;

        CheckResult {
            monitor_name: self.name(),
            monitor_type: "event_log".to_string(),
            status,
            message,
            response_time_ms: Some(start.elapsed().as_millis() as u64),
            metadata: meta,
            timestamp: Utc::now(),
        }
    }
}

#[cfg(not(windows))]
async fn run_event_log_query(
    _channel: &str,
    _provider: &str,
    _event_id: u32,
    _window_secs: u64,
) -> (CheckStatus, String, Option<serde_json::Value>) {
    (
        CheckStatus::Unknown,
        "event_log monitor requires Windows".to_string(),
        None,
    )
}

#[cfg(windows)]
async fn run_event_log_query(
    channel: &str,
    provider: &str,
    event_id: u32,
    window_secs: u64,
) -> (CheckStatus, String, Option<serde_json::Value>) {
    use tokio::process::Command;

    // Escape single quotes in the provider name for the XPath literal. wevtutil
    // XPath uses single-quoted attribute values, so we can't allow them in the
    // provider string — refuse instead of silently mangling.
    if provider.contains('\'') {
        return (
            CheckStatus::Unknown,
            "provider name may not contain single quotes".to_string(),
            None,
        );
    }

    // XPath filter: limit to recent events by TimeCreated (milliseconds), and
    // to the specified provider + event id.
    let window_ms = window_secs.saturating_mul(1000);
    let query = format!(
        "*[System[Provider[@Name='{provider}'] and (EventID={event_id}) and TimeCreated[timediff(@SystemTime) <= {window_ms}]]]"
    );

    let output = Command::new("wevtutil")
        .args([
            "qe",
            channel,
            &format!("/q:{}", query),
            "/c:100",
            "/f:text",
            "/rd:true",
        ])
        .output()
        .await;

    let out = match output {
        Ok(o) => o,
        Err(e) => {
            return (
                CheckStatus::Unknown,
                format!("failed to run wevtutil: {e}"),
                None,
            );
        }
    };

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return (
            CheckStatus::Unknown,
            format!("wevtutil exited non-zero: {}", stderr.trim()),
            None,
        );
    }

    // Text format emits one "Event[N]:" header per event — count those.
    // Fall back to counting "Event ID:" lines if the header pattern shifts.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let count = stdout
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            t.starts_with("Event[") || t.starts_with("Event ID")
        })
        .count();

    let meta = serde_json::json!({
        "channel": channel,
        "provider": provider,
        "event_id": event_id,
        "window_secs": window_secs,
        "count": count,
    });

    if count > 0 {
        (
            CheckStatus::Critical,
            format!(
                "{count} event(s) matching provider='{provider}' id={event_id} on {channel} within {window_secs}s"
            ),
            Some(meta),
        )
    } else {
        (
            CheckStatus::Ok,
            format!(
                "no matching events on {channel} for provider='{provider}' id={event_id} in last {window_secs}s"
            ),
            Some(meta),
        )
    }
}
