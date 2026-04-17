use super::{CheckResult, CheckStatus, Monitor, async_trait};
use crate::net_safety;
use chrono::Utc;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;

/// Monitors a TCP port by attempting a connection.
pub struct PortMonitor {
    host: String,
    port: u16,
    timeout: Duration,
}

impl PortMonitor {
    pub fn new(host: String, port: u16, timeout_ms: u64) -> Self {
        Self {
            host,
            port,
            timeout: Duration::from_millis(timeout_ms),
        }
    }
}

#[async_trait]
impl Monitor for PortMonitor {
    async fn check(&self) -> CheckResult {
        let addr = format!("{}:{}", self.host, self.port);

        // Refuse scanning of internal hosts from a compromised Hub.
        if !net_safety::host_allowed(&self.host) || !net_safety::safe_argv_target(&self.host) {
            return CheckResult {
                monitor_name: format!("port:{addr}"),
                monitor_type: "port".to_string(),
                status: CheckStatus::Unknown,
                message: format!(
                    "Refusing port probe to internal/private host {} (set VIGIL_ALLOW_INTERNAL_NET=1 to override)",
                    self.host
                ),
                response_time_ms: None,
                metadata: None,
                timestamp: Utc::now(),
            };
        }

        let start = Instant::now();

        let result = tokio::time::timeout(self.timeout, TcpStream::connect(&addr)).await;
        let elapsed = start.elapsed().as_millis() as u64;

        let (status, message) = match result {
            Ok(Ok(_)) => (CheckStatus::Ok, format!("Port {addr} is open")),
            Ok(Err(e)) => (
                CheckStatus::Critical,
                format!("Port {addr} connection refused: {e}"),
            ),
            Err(_) => (
                CheckStatus::Critical,
                format!("Port {addr} timed out after {}ms", self.timeout.as_millis()),
            ),
        };

        CheckResult {
            monitor_name: format!("port:{addr}"),
            monitor_type: "port".to_string(),
            status,
            message,
            response_time_ms: Some(elapsed),
            metadata: None,
            timestamp: Utc::now(),
        }
    }
}
