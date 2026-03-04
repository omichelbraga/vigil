use anyhow::{Context, Result};
use serde::Deserialize;
use std::time::Duration;
use tokio::fs;
use tracing::{error, info};

#[derive(Debug, Deserialize)]
struct ReleaseInfo {
    version: String,
    sha256: String,
    download_url: String,
}

/// Self-updater that polls the Hub for new agent releases.
pub struct Updater {
    hub_url: String,
    hub_token: String,
    current_version: String,
    check_interval: Duration,
}

impl Updater {
    pub fn new(hub_url: &str, hub_token: &str) -> Self {
        // Strip /ws from the hub_url to get the base API URL
        let base = hub_url
            .trim_end_matches("/ws")
            .trim_end_matches("/ws/agent");

        Self {
            hub_url: base.replace("wss://", "https://").replace("ws://", "http://"),
            hub_token: hub_token.to_string(),
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            check_interval: Duration::from_secs(3600), // 1 hour
        }
    }

    pub async fn run(&self) {
        let mut interval = tokio::time::interval(self.check_interval);

        loop {
            interval.tick().await;

            if let Err(e) = self.check_and_update().await {
                error!(error = %e, "Update check failed");
            }
        }
    }

    async fn check_and_update(&self) -> Result<()> {
        let os = std::env::consts::OS;
        let arch = std::env::consts::ARCH;

        let url = format!(
            "{}/api/update/agent/{}/{}/version",
            self.hub_url, os, arch
        );

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;

        let resp = client
            .get(&url)
            .send()
            .await
            .context("Failed to check for updates")?;

        if !resp.status().is_success() {
            return Ok(()); // No update available or endpoint not configured
        }

        let release: ReleaseInfo = resp.json().await.context("Invalid release info")?;

        if release.version == self.current_version {
            info!(version = %self.current_version, "Agent is up to date");
            return Ok(());
        }

        info!(
            current = %self.current_version,
            available = %release.version,
            "New agent version available, downloading"
        );

        self.download_and_apply(&release).await
    }

    async fn download_and_apply(&self, release: &ReleaseInfo) -> Result<()> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()?;

        let resp = client
            .get(&release.download_url)
            .bearer_auth(&self.hub_token)
            .send()
            .await
            .context("Failed to download update")?;

        if !resp.status().is_success() {
            anyhow::bail!("Download failed with status {}", resp.status());
        }

        let bytes = resp.bytes().await.context("Failed to read update binary")?;

        // Verify SHA256
        use std::io::Write;
        let digest = {
            let mut hasher = sha2_hasher();
            hasher.write_all(&bytes)?;
            hasher.finalize_hex()
        };

        if digest != release.sha256 {
            anyhow::bail!(
                "SHA256 mismatch: expected {}, got {}",
                release.sha256,
                digest
            );
        }

        info!(sha256 = %release.sha256, "SHA256 verified, applying update");

        // Write to temp file
        let current_exe = std::env::current_exe().context("Cannot determine current binary path")?;
        let tmp_path = current_exe.with_extension("update");
        fs::write(&tmp_path, &bytes).await.context("Failed to write update binary")?;

        // Make executable on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o755);
            std::fs::set_permissions(&tmp_path, perms)?;
        }

        // Replace current binary
        let backup_path = current_exe.with_extension("backup");
        if backup_path.exists() {
            let _ = fs::remove_file(&backup_path).await;
        }
        fs::rename(&current_exe, &backup_path).await.context("Failed to backup current binary")?;
        fs::rename(&tmp_path, &current_exe).await.context("Failed to replace binary")?;

        info!(version = %release.version, "Update applied, restarting");

        // Restart: on Unix use exec, on Windows just exit and let service manager restart
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let args: Vec<String> = std::env::args().collect();
            let err = std::process::Command::new(&current_exe)
                .args(&args[1..])
                .exec();
            error!(error = %err, "Failed to exec new binary");
        }

        #[cfg(windows)]
        {
            warn!("Update applied. Please restart the agent service.");
            std::process::exit(0);
        }

        #[cfg(not(any(unix, windows)))]
        {
            warn!("Update applied. Please restart the agent manually.");
            std::process::exit(0);
        }

        Ok(())
    }
}

/// Simple SHA256 hasher wrapper
struct Sha256Hasher {
    data: Vec<u8>,
}

fn sha2_hasher() -> Sha256Hasher {
    Sha256Hasher { data: Vec::new() }
}

impl std::io::Write for Sha256Hasher {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.data.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Sha256Hasher {
    fn finalize_hex(self) -> String {
        // Use ring for SHA256
        use ring::digest;
        let d = digest::digest(&digest::SHA256, &self.data);
        hex::encode(d.as_ref())
    }
}
