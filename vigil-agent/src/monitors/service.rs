use super::{CheckResult, CheckStatus, Monitor, async_trait};
use chrono::Utc;
use std::time::Instant;
use tokio::process::Command;

/// Monitors a system service (systemd on Linux, sc.exe on Windows).
pub struct ServiceMonitor {
    service_name: String,
}

impl ServiceMonitor {
    pub fn new(service_name: String) -> Self {
        Self { service_name }
    }
}

#[async_trait]
impl Monitor for ServiceMonitor {
    async fn check(&self) -> CheckResult {
        let start = Instant::now();
        let (status, message) = check_service(&self.service_name).await;
        let elapsed = start.elapsed().as_millis() as u64;

        CheckResult {
            monitor_name: format!("service:{}", self.service_name),
            monitor_type: "service".to_string(),
            status,
            message,
            response_time_ms: Some(elapsed),
            metadata: None,
            timestamp: Utc::now(),
        }
    }
}

#[cfg(target_os = "linux")]
async fn check_service(name: &str) -> (CheckStatus, String) {
    let output = Command::new("systemctl")
        .args(["is-active", name])
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            match stdout.as_str() {
                "active" => (CheckStatus::Ok, format!("Service {name} is active")),
                "inactive" => (CheckStatus::Critical, format!("Service {name} is inactive")),
                "failed" => (CheckStatus::Critical, format!("Service {name} has failed")),
                other => (CheckStatus::Warning, format!("Service {name} is {other}")),
            }
        }
        Err(e) => (
            CheckStatus::Unknown,
            format!("Failed to check service {name}: {e}"),
        ),
    }
}

#[cfg(target_os = "windows")]
async fn check_service(name: &str) -> (CheckStatus, String) {
    let output = Command::new("sc.exe")
        .args(["query", name])
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if stdout.contains("RUNNING") {
                (CheckStatus::Ok, format!("Service {name} is running"))
            } else if stdout.contains("STOPPED") {
                (CheckStatus::Critical, format!("Service {name} is stopped"))
            } else {
                (CheckStatus::Warning, format!("Service {name} status unknown"))
            }
        }
        Err(e) => (
            CheckStatus::Unknown,
            format!("Failed to check service {name}: {e}"),
        ),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
async fn check_service(name: &str) -> (CheckStatus, String) {
    (
        CheckStatus::Unknown,
        format!("Service monitoring not supported on this platform for {name}"),
    )
}
