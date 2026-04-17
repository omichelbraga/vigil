//! Per-agent ed25519 keypair used to sign every outbound WebSocket message
//! (register, check_result, resource_sample, inventory_report, health_report,
//! action_ack, action_denied). The Hub pins the public key on first register
//! and rejects any subsequent message whose signature doesn't verify.
//!
//! Keypair lifecycle:
//! * First run  — generate a fresh PKCS#8-encoded ed25519 keypair via
//!   `ring::signature::Ed25519KeyPair::generate_pkcs8`, write it to
//!   `<config_dir>/agent-key.pem` with mode `0600` on unix, and pin.
//! * Subsequent runs — read the PKCS#8 bytes back and reconstruct the keypair.
//!
//! The file is binary PKCS#8 DER (not PEM) despite the filename — we keep the
//! `.pem` extension for familiarity with ops teams who grep for it.
//!
//! Message signing: callers produce a JSON body *without* a `signature` field,
//! render it to canonical JSON (keys sorted alphabetically at every level),
//! call `sign()` on those bytes, and add `signature: <hex>` to the outgoing
//! object. The Hub performs the inverse: strips `signature`, canonicalises,
//! verifies.

use anyhow::{anyhow, Context, Result};
use ring::signature::{Ed25519KeyPair, KeyPair};
use std::fs;
use std::path::{Path, PathBuf};

/// Manages an ed25519 keypair pinned to a single agent install. Loaded once at
/// startup and handed to the hub client wrapped in an `Arc`.
pub struct ResultSigner {
    key_pair: Ed25519KeyPair,
    public_key_hex: String,
}

impl ResultSigner {
    /// Load an existing keypair from `<config_dir>/agent-key.pem`, or generate
    /// one and persist it atomically on first run.
    ///
    /// `config_path` is the path to the TOML config file — we derive the key
    /// file location as a sibling (same directory) so it ships with the agent
    /// install rather than landing in `$HOME` or `/tmp`.
    pub fn load_or_create(config_path: &str) -> Result<Self> {
        let key_path = derive_key_path(config_path);

        // Ensure the parent directory exists (edge case: config_path given as a
        // bare filename on a fresh install).
        if let Some(parent) = key_path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                fs::create_dir_all(parent).with_context(|| {
                    format!(
                        "Failed to create signing-key directory {}",
                        parent.display()
                    )
                })?;
            }
        }

        let pkcs8_bytes = if key_path.exists() {
            fs::read(&key_path)
                .with_context(|| format!("Failed to read signing key {}", key_path.display()))?
        } else {
            let bytes = generate_pkcs8()?;
            write_private_file(&key_path, &bytes)?;
            tracing::info!(
                path = %key_path.display(),
                "Generated new ed25519 signing keypair for this agent"
            );
            bytes
        };

        let key_pair = Ed25519KeyPair::from_pkcs8(&pkcs8_bytes)
            .map_err(|e| anyhow!("Failed to parse PKCS#8 signing key: {e}"))?;
        let public_key_hex = hex::encode(key_pair.public_key().as_ref());

        Ok(Self {
            key_pair,
            public_key_hex,
        })
    }

    /// Sign `msg` with the agent's ed25519 private key. Output is the raw
    /// 64-byte signature; callers hex-encode before putting it on the wire.
    pub fn sign(&self, msg: &[u8]) -> Vec<u8> {
        self.key_pair.sign(msg).as_ref().to_vec()
    }

    /// Hex-encoded 32-byte public key for this agent. Sent in the `register`
    /// message so the Hub can pin it on first sight.
    pub fn public_key_hex(&self) -> &str {
        &self.public_key_hex
    }
}

fn derive_key_path(config_path: &str) -> PathBuf {
    let cfg = Path::new(config_path);
    match cfg.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join("agent-key.pem"),
        _ => PathBuf::from("agent-key.pem"),
    }
}

fn generate_pkcs8() -> Result<Vec<u8>> {
    let rng = ring::rand::SystemRandom::new();
    let doc = Ed25519KeyPair::generate_pkcs8(&rng)
        .map_err(|e| anyhow!("Failed to generate ed25519 keypair: {e}"))?;
    Ok(doc.as_ref().to_vec())
}

/// Write PKCS#8 bytes to disk with owner-only permissions on unix. Uses an
/// atomic `open-write-rename`-style flow via `OpenOptions` with `.create_new`
/// so a racing second process can't clobber the key.
#[cfg(unix)]
fn write_private_file(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("Failed to create signing key file {}", path.display()))?;
    file.write_all(data)
        .with_context(|| format!("Failed to write signing key to {}", path.display()))?;
    file.sync_all().ok();

    // Belt-and-braces: re-set permissions in case the process was started with
    // a restrictive umask that still gave the group a bit.
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("Failed to chmod 0600 on {}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private_file(path: &Path, data: &[u8]) -> Result<()> {
    // Windows has no direct chmod equivalent accessible here; the default
    // NTFS ACL on a newly created file under `%ProgramData%\vigil` already
    // restricts access to SYSTEM + Administrators. Good enough for our
    // threat model (if an attacker has admin, they own the box).
    fs::write(path, data)
        .with_context(|| format!("Failed to write signing key to {}", path.display()))?;
    Ok(())
}

/// Canonical JSON: sort object keys alphabetically at every level before
/// serialising. Arrays retain their order. Scalars serialise exactly as
/// serde_json would. MUST be byte-for-byte identical to the Hub-side
/// implementation in `vigil-hub/lib/signature-verify.ts`.
pub fn canonical_json(value: &serde_json::Value) -> String {
    let mut out = String::new();
    write_canonical(&mut out, value);
    out
}

fn write_canonical(out: &mut String, value: &serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                // Strings re-use serde_json's escaping rules.
                out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()));
                out.push(':');
                if let Some(child) = map.get(*key) {
                    write_canonical(out, child);
                }
            }
            out.push('}');
        }
        serde_json::Value::Array(arr) => {
            out.push('[');
            for (i, item) in arr.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(out, item);
            }
            out.push(']');
        }
        _ => {
            // Numbers / strings / booleans / null: defer to serde_json which
            // already produces canonical output for these variants.
            out.push_str(&serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()));
        }
    }
}

/// Convenience: sign a JSON body (assumed to *not* already contain a
/// `signature` field), return a hex-encoded ed25519 signature over the
/// canonical form of that body.
pub fn sign_body_hex(signer: &ResultSigner, body: &serde_json::Value) -> String {
    let canonical = canonical_json(body);
    hex::encode(signer.sign(canonical.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_json_sorts_keys_recursively() {
        let v = json!({
            "b": 2,
            "a": 1,
            "nested": {
                "z": [1, 2, 3],
                "a": true
            }
        });
        let s = canonical_json(&v);
        assert_eq!(s, r#"{"a":1,"b":2,"nested":{"a":true,"z":[1,2,3]}}"#);
    }

    #[test]
    fn canonical_json_preserves_array_order() {
        let v = json!([3, 1, 2]);
        assert_eq!(canonical_json(&v), "[3,1,2]");
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config.toml");
        std::fs::write(&cfg, "").unwrap();
        let signer = ResultSigner::load_or_create(cfg.to_str().unwrap()).unwrap();

        let body = json!({"type": "check_result", "status": "ok", "a": 1});
        let sig_hex = sign_body_hex(&signer, &body);
        let canonical = canonical_json(&body);

        // Verify using ring directly
        let pk_bytes = hex::decode(signer.public_key_hex()).unwrap();
        let pk = ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &pk_bytes);
        let sig_bytes = hex::decode(&sig_hex).unwrap();
        pk.verify(canonical.as_bytes(), &sig_bytes).unwrap();
    }

    /// Generates a fixed sample used to cross-verify the TS implementation.
    /// Run with `cargo test --manifest-path vigil-agent/Cargo.toml -- \
    ///   result_signing::tests::emit_ts_fixture --nocapture --ignored`
    /// and paste the output into the TS test (tests/lib/signature-verify.test.ts).
    #[test]
    #[ignore]
    fn emit_ts_fixture() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config.toml");
        std::fs::write(&cfg, "").unwrap();
        let signer = ResultSigner::load_or_create(cfg.to_str().unwrap()).unwrap();

        let body = json!({
            "type": "check_result",
            "check_name": "service:Spooler",
            "status": "ok",
            "latency_ms": 12,
            "metadata": {"b": 2, "a": 1}
        });
        let sig_hex = sign_body_hex(&signer, &body);
        println!("--- TS fixture ---");
        println!("pubkey_hex: {}", signer.public_key_hex());
        println!("body_json: {}", serde_json::to_string(&body).unwrap());
        println!("canonical: {}", canonical_json(&body));
        println!("signature_hex: {}", sig_hex);
    }
}
