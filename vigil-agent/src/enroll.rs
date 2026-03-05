use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct EnrollRequest {
    enrollment_token: String,
    hostname: String,
    os: String,
    version: String,
    ip: String,
}

#[derive(Deserialize)]
struct EnrollResponse {
    agent_id: String,
    token: String,
}

pub async fn enroll(hub_url: &str, enrollment_token: &str) -> Result<(String, String)> {
    let http_url = hub_url
        .replace("wss://", "https://")
        .replace("ws://", "http://");
    let http_url = http_url.trim_end_matches("/");

    let hostname = sysinfo::System::host_name().unwrap_or_else(|| "unknown".to_string());
    let os = std::env::consts::OS.to_string();
    let version = env!("CARGO_PKG_VERSION").to_string();
    let ip = get_local_ip().unwrap_or_else(|| "unknown".to_string());

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    let resp = client
        .post(format!("{}/api/enroll", http_url))
        .json(&EnrollRequest {
            enrollment_token: enrollment_token.to_string(),
            hostname: hostname.clone(),
            os,
            version,
            ip,
        })
        .send()
        .await
        .context("Failed to reach Hub — is the hub URL correct?")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Enrollment failed ({}): {}", status, body);
    }

    let data: EnrollResponse = resp.json().await.context("Invalid response from Hub")?;
    Ok((data.agent_id, data.token))
}

fn get_local_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}
