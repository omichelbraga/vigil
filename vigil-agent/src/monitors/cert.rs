use super::{CheckResult, CheckStatus, Monitor, async_trait};
use chrono::Utc;
use std::time::Instant;
use tokio::process::Command;

/// Monitors TLS certificate expiry for a remote host.
pub struct CertMonitor {
    host: String,
    port: u16,
    warn_days: u32,
}

impl CertMonitor {
    pub fn new(host: String, port: u16, warn_days: u32) -> Self {
        Self {
            host,
            port,
            warn_days,
        }
    }
}

#[async_trait]
impl Monitor for CertMonitor {
    async fn check(&self) -> CheckResult {
        let start = Instant::now();
        let (status, message) = check_cert(&self.host, self.port, self.warn_days).await;
        let elapsed = start.elapsed().as_millis() as u64;

        CheckResult {
            monitor_name: format!("cert:{}:{}", self.host, self.port),
            monitor_type: "cert".to_string(),
            status,
            message,
            response_time_ms: Some(elapsed),
            timestamp: Utc::now(),
        }
    }
}

async fn check_cert(host: &str, port: u16, warn_days: u32) -> (CheckStatus, String) {
    // Use openssl s_client to fetch the certificate and check expiry
    let connect_arg = format!("{host}:{port}");
    let output = Command::new("openssl")
        .args([
            "s_client",
            "-connect",
            &connect_arg,
            "-servername",
            host,
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;

    let cert_pem = match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_string(),
        Err(e) => {
            return (
                CheckStatus::Unknown,
                format!("Failed to connect to {host}:{port}: {e}"),
            );
        }
    };

    // Parse the end date using openssl x509
    let x509_output = Command::new("openssl")
        .args(["x509", "-noout", "-enddate"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;

    // Use openssl to check if cert expires within warn_days
    let check_output = Command::new("openssl")
        .args([
            "x509",
            "-noout",
            "-checkend",
            &(warn_days * 86400).to_string(),
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;

    // For the scaffold, use a simplified approach via openssl s_client piped to x509
    let _ = (cert_pem, x509_output, check_output);

    // Stub: In production, parse PEM from s_client and feed to x509 via stdin.
    // For now, report unknown until full TLS inspection is wired up.
    (
        CheckStatus::Unknown,
        format!("Cert check for {host}:{port} — stub, full TLS inspection pending"),
    )
}
