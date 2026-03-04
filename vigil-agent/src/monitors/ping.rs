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
        let (status, message) = run_ping(&self.target).await;
        let elapsed = start.elapsed().as_millis() as u64;

        CheckResult {
            monitor_name: format!("ping:{}", self.target),
            monitor_type: "ping".to_string(),
            status,
            message,
            response_time_ms: Some(elapsed),
            timestamp: Utc::now(),
        }
    }
}

#[cfg(target_os = "windows")]
async fn run_ping(target: &str) -> (CheckStatus, String) {
    let output = Command::new("ping")
        .args(["-n", "1", "-w", "5000", target])
        .output()
        .await;

    parse_ping_output(target, output)
}

#[cfg(not(target_os = "windows"))]
async fn run_ping(target: &str) -> (CheckStatus, String) {
    let output = Command::new("ping")
        .args(["-c", "1", "-W", "5", target])
        .output()
        .await;

    parse_ping_output(target, output)
}

fn parse_ping_output(
    target: &str,
    output: Result<std::process::Output, std::io::Error>,
) -> (CheckStatus, String) {
    match output {
        Ok(out) => {
            if out.status.success() {
                (CheckStatus::Ok, format!("{target} is reachable"))
            } else {
                (
                    CheckStatus::Critical,
                    format!("{target} is unreachable"),
                )
            }
        }
        Err(e) => (
            CheckStatus::Unknown,
            format!("Failed to execute ping for {target}: {e}"),
        ),
    }
}
