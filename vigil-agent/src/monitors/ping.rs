use super::{CheckResult, CheckStatus, Monitor, async_trait};
use chrono::Utc;
use std::time::Instant;
use tokio::process::Command;

/// Monitors host reachability via ping (platform-specific).
pub struct PingMonitor {
    target: String,
}

impl PingMonitor {
    pub fn new(target: String) -> Self {
        Self { target }
    }
}

#[async_trait]
impl Monitor for PingMonitor {
    async fn check(&self) -> CheckResult {
        let start = Instant::now();
        let (status, message, rtt) = run_ping(&self.target).await;
        let elapsed = start.elapsed().as_millis() as u64;

        let meta = rtt.map(|r| serde_json::json!({ "rtt_ms": r }));

        CheckResult {
            monitor_name: format!("ping:{}", self.target),
            monitor_type: "ping".to_string(),
            status,
            message,
            response_time_ms: Some(rtt.unwrap_or(elapsed)),
            metadata: meta,
            timestamp: Utc::now(),
        }
    }
}

#[cfg(target_os = "windows")]
async fn run_ping(target: &str) -> (CheckStatus, String, Option<u64>) {
    let output = Command::new("ping")
        .args(["-n", "1", "-w", "2000", target])
        .output()
        .await;

    parse_ping_output(target, output)
}

#[cfg(not(target_os = "windows"))]
async fn run_ping(target: &str) -> (CheckStatus, String, Option<u64>) {
    let output = Command::new("ping")
        .args(["-c", "1", "-W", "2", target])
        .output()
        .await;

    parse_ping_output(target, output)
}

fn parse_ping_output(
    target: &str,
    output: Result<std::process::Output, std::io::Error>,
) -> (CheckStatus, String, Option<u64>) {
    match output {
        Ok(out) => {
            if out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let rtt = parse_rtt(&stdout);
                let msg = match rtt {
                    Some(ms) => format!("{target} reachable, RTT {ms}ms"),
                    None => format!("{target} is reachable"),
                };
                (CheckStatus::Ok, msg, rtt)
            } else {
                (CheckStatus::Critical, format!("{target} is unreachable"), None)
            }
        }
        Err(e) => (
            CheckStatus::Unknown,
            format!("Failed to execute ping for {target}: {e}"),
            None,
        ),
    }
}

/// Parse RTT from ping output. Looks for "time=X.X ms" or "time<1ms" patterns.
fn parse_rtt(output: &str) -> Option<u64> {
    // Linux: "time=1.23 ms"
    if let Some(pos) = output.find("time=") {
        let after = &output[pos + 5..];
        let num_str: String = after.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        return num_str.parse::<f64>().ok().map(|v| v as u64);
    }
    // Windows: "time=1ms" or "time<1ms"
    if output.find("time<").is_some() {
        return Some(0);
    }
    None
}
