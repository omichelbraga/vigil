use anyhow::{Context, Result};
use serde::Deserialize;
use std::time::Duration;
use tokio::fs;
use tracing::{error, info, warn};

/// Release metadata returned by the Hub.
///
/// `signature` is an ed25519 signature, hex-encoded, over the ASCII-encoded
/// SHA-256 hex of the binary. The Hub operator owns the signing key;
/// the public key is embedded in this agent at build time via the
/// `VIGIL_UPDATE_PUBKEY` env var. Without that key, auto-update is refused.
#[derive(Debug, Deserialize)]
struct ReleaseInfo {
    version: String,
    sha256: String,
    download_url: String,
    #[serde(default)]
    signature: String,
}

/// Ed25519 public key (hex) embedded at compile time. Set with:
///   VIGIL_UPDATE_PUBKEY=<64-hex-chars> cargo build --release
/// When empty, the updater refuses to apply any release (fail-safe).
const UPDATE_PUBKEY_HEX: &str = match option_env!("VIGIL_UPDATE_PUBKEY") {
    Some(v) => v,
    None => "",
};

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
        if UPDATE_PUBKEY_HEX.is_empty() {
            warn!(
                "Auto-update requested but no signing key compiled in (VIGIL_UPDATE_PUBKEY unset at build). \
                 Updates will be refused — rebuild the agent with a pinned ed25519 pubkey to enable."
            );
        }
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

        let url = format!("{}/api/update/agent/{}/{}/version", self.hub_url, os, arch);
        if !url.starts_with("https://") {
            anyhow::bail!("Refusing to pull update metadata over plaintext HTTP");
        }

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;

        let resp = client.get(&url).send().await.context("Failed to check for updates")?;
        if !resp.status().is_success() {
            return Ok(()); // No update available or endpoint not configured
        }

        let release: ReleaseInfo = resp.json().await.context("Invalid release info")?;
        if release.version == self.current_version {
            info!(version = %self.current_version, "Agent is up to date");
            return Ok(());
        }

        info!(current = %self.current_version, available = %release.version, "New agent version available");
        self.download_and_apply(&release).await
    }

    async fn download_and_apply(&self, release: &ReleaseInfo) -> Result<()> {
        // 1. Hard-fail if we don't have a compiled-in signing key.
        if UPDATE_PUBKEY_HEX.is_empty() {
            anyhow::bail!(
                "Refusing update: no VIGIL_UPDATE_PUBKEY compiled into this agent"
            );
        }
        if release.signature.is_empty() {
            anyhow::bail!("Refusing update: Hub did not supply a signature");
        }

        // 2. Pin download URL scheme + origin. The Hub is not trusted to point
        //    the agent at arbitrary hosts — only relative artifacts hosted by
        //    the same Hub origin that served the metadata.
        let download_url = normalise_download_url(&self.hub_url, &release.download_url)?;
        info!(url = %download_url, "Downloading update");

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()?;

        let resp = client
            .get(&download_url)
            .bearer_auth(&self.hub_token)
            .send()
            .await
            .context("Failed to download update")?;
        if !resp.status().is_success() {
            anyhow::bail!("Download failed with status {}", resp.status());
        }

        let bytes = resp.bytes().await.context("Failed to read update binary")?;

        // 3. Verify SHA-256 of the downloaded bytes.
        let digest = sha256_hex(&bytes);
        if digest != release.sha256 {
            anyhow::bail!("SHA256 mismatch: expected {}, got {}", release.sha256, digest);
        }

        // 4. Verify ed25519 signature over the SHA-256 hex string.
        //    This is the critical check: without a valid signature from the
        //    operator's signing key, a compromised Hub cannot push a binary.
        verify_signature(&digest, &release.signature)
            .context("Update signature verification failed — aborting")?;

        info!(sha256 = %digest, "Update signature verified, applying");

        // 5. Atomic swap.
        let current_exe = std::env::current_exe().context("Cannot determine current binary path")?;
        let tmp_path = current_exe.with_extension("update");
        fs::write(&tmp_path, &bytes).await.context("Failed to write update binary")?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o755);
            std::fs::set_permissions(&tmp_path, perms)?;
        }

        let backup_path = current_exe.with_extension("backup");
        if backup_path.exists() {
            let _ = fs::remove_file(&backup_path).await;
        }
        fs::rename(&current_exe, &backup_path)
            .await
            .context("Failed to backup current binary")?;
        fs::rename(&tmp_path, &current_exe)
            .await
            .context("Failed to replace binary")?;

        info!(version = %release.version, "Update applied, restarting");

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let args: Vec<String> = std::env::args().collect();
            let err = std::process::Command::new(&current_exe)
                .args(&args[1..])
                .exec();
            error!(error = %err, "Failed to exec new binary");
            Ok(())
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
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

fn verify_signature(digest_hex: &str, signature_hex: &str) -> Result<()> {
    use ring::signature::{UnparsedPublicKey, ED25519};
    let pubkey_bytes =
        hex::decode(UPDATE_PUBKEY_HEX).context("Embedded update pubkey is not valid hex")?;
    if pubkey_bytes.len() != 32 {
        anyhow::bail!("Embedded update pubkey must be 32 bytes, got {}", pubkey_bytes.len());
    }
    let sig_bytes = hex::decode(signature_hex).context("Signature is not valid hex")?;
    if sig_bytes.len() != 64 {
        anyhow::bail!("Ed25519 signature must be 64 bytes, got {}", sig_bytes.len());
    }
    let pubkey = UnparsedPublicKey::new(&ED25519, &pubkey_bytes);
    pubkey
        .verify(digest_hex.as_bytes(), &sig_bytes)
        .map_err(|_| anyhow::anyhow!("Signature did not verify against embedded update pubkey"))?;
    Ok(())
}

/// Only accept download URLs on the same origin the Hub served the metadata from.
/// A relative `/releases/foo.bin` is allowed; a scheme-qualified URL must match
/// `hub_url` host+scheme. This prevents a compromised Hub from redirecting the
/// agent to `https://attacker.example/evil.bin`.
fn normalise_download_url(hub_url: &str, download_url: &str) -> Result<String> {
    if download_url.starts_with('/') {
        return Ok(format!("{}{}", hub_url.trim_end_matches('/'), download_url));
    }
    // Absolute URL — must match Hub origin exactly.
    let hub_origin = origin_of(hub_url).context("Invalid hub_url")?;
    let dl_origin = origin_of(download_url).context("Invalid download_url")?;
    if hub_origin != dl_origin {
        anyhow::bail!(
            "Refusing update: download_url origin {} does not match Hub origin {}",
            dl_origin,
            hub_origin
        );
    }
    if !download_url.starts_with("https://") {
        anyhow::bail!("Refusing update: download_url must be https");
    }
    Ok(download_url.to_string())
}

fn origin_of(u: &str) -> Option<String> {
    let (scheme, rest) = u.split_once("://")?;
    let host = rest.split('/').next()?;
    Some(format!("{}://{}", scheme, host))
}
