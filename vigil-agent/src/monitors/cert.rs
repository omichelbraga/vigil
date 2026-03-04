use super::{CheckResult, CheckStatus, Monitor, async_trait};
use chrono::Utc;
use std::sync::Arc;
use std::time::Instant;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

/// Monitors TLS certificate expiry for a remote host using rustls.
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
        let (status, message, meta) = check_cert(&self.host, self.port, self.warn_days).await;
        let elapsed = start.elapsed().as_millis() as u64;

        CheckResult {
            monitor_name: format!("cert:{}:{}", self.host, self.port),
            monitor_type: "cert".to_string(),
            status,
            message,
            response_time_ms: Some(elapsed),
            metadata: meta,
            timestamp: Utc::now(),
        }
    }
}

async fn check_cert(
    host: &str,
    port: u16,
    warn_days: u32,
) -> (CheckStatus, String, Option<serde_json::Value>) {
    // Build a rustls config that captures the peer certificates
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    let config = match rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth()
    {
        c => c,
    };

    let connector = TlsConnector::from(Arc::new(config));
    let addr = format!("{host}:{port}");

    let tcp = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        TcpStream::connect(&addr),
    )
    .await
    {
        Ok(Ok(tcp)) => tcp,
        Ok(Err(e)) => {
            return (
                CheckStatus::Critical,
                format!("TCP connect to {addr} failed: {e}"),
                None,
            );
        }
        Err(_) => {
            return (
                CheckStatus::Critical,
                format!("TCP connect to {addr} timed out"),
                None,
            );
        }
    };

    let server_name = match rustls::pki_types::ServerName::try_from(host.to_string()) {
        Ok(sn) => sn,
        Err(e) => {
            return (
                CheckStatus::Unknown,
                format!("Invalid server name {host}: {e}"),
                None,
            );
        }
    };

    let tls_stream = match connector.connect(server_name, tcp).await {
        Ok(s) => s,
        Err(e) => {
            return (
                CheckStatus::Critical,
                format!("TLS handshake with {host}:{port} failed: {e}"),
                None,
            );
        }
    };

    // Extract peer certificates
    let (_, conn) = tls_stream.get_ref();
    let certs = match conn.peer_certificates() {
        Some(c) if !c.is_empty() => c,
        _ => {
            return (
                CheckStatus::Critical,
                format!("No peer certificate from {host}:{port}"),
                None,
            );
        }
    };

    // Parse the leaf certificate
    let leaf_der = &certs[0];
    let parsed = match x509_parser::parse_x509_certificate(leaf_der.as_ref()) {
        Ok((_, cert)) => cert,
        Err(e) => {
            return (
                CheckStatus::Unknown,
                format!("Failed to parse certificate from {host}:{port}: {e}"),
                None,
            );
        }
    };

    let not_after = parsed.validity().not_after.to_datetime();
    let subject = parsed.subject().to_string();

    let now = chrono::Utc::now();
    let expiry_dt = chrono::DateTime::<chrono::Utc>::from_timestamp(
        not_after.unix_timestamp(),
        0,
    )
    .unwrap_or(now);

    let days_until = (expiry_dt - now).num_days();

    let meta = serde_json::json!({
        "days_until_expiry": days_until,
        "expiry_date": expiry_dt.to_rfc3339(),
        "subject": subject,
    });

    let (status, message) = if days_until < 0 {
        (
            CheckStatus::Critical,
            format!("{host} cert expired {} days ago", -days_until),
        )
    } else if days_until <= warn_days as i64 {
        (
            CheckStatus::Warning,
            format!("{host} cert expires in {days_until} days"),
        )
    } else {
        (
            CheckStatus::Ok,
            format!("{host} cert valid, {days_until} days remaining"),
        )
    };

    (status, message, Some(meta))
}
