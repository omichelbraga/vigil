//! Library surface of the vigil-agent crate.
//!
//! The binary (`src/main.rs`) is a thin clap/tokio shim that delegates into
//! here. All non-entrypoint code lives in this crate so integration tests
//! under `tests/` can exercise real module code without re-declaring it.

pub mod buffer;
pub mod config;
pub mod doctor;
pub mod enroll;
pub mod hub_client;
pub mod installer;
pub mod inventory;
pub mod ipc;
pub mod ipc_client;
pub mod monitors;
pub mod net_safety;
pub mod resource_sampler;
pub mod result_signing;
pub mod updater;

use once_cell::sync::Lazy;

/// Return the Vigil mutable-data directory for this host.
///
/// On Windows this is `%ProgramData%\Vigil` — the standard location for
/// machine-wide mutable state owned by a system service. The MSI installer
/// creates this directory; for non-MSI installs the directory is created
/// lazily by [`installer::write_config`].
///
/// On non-Windows targets this returns `None` so callers fall back to
/// exe-relative resolution (the historical behavior — Linux systemd units
/// set `WorkingDirectory` to the config dir, which is enough).
#[cfg(windows)]
pub fn vigil_data_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("ProgramData")
        .unwrap_or_else(|| std::ffi::OsString::from(r"C:\ProgramData"));
    Some(std::path::PathBuf::from(base).join("Vigil"))
}

#[cfg(not(windows))]
pub fn vigil_data_dir() -> Option<std::path::PathBuf> {
    None
}

/// Resolve a (possibly relative) data-file path against the Vigil data
/// directory. Absolute paths pass through unchanged. Relative paths are
/// joined against [`vigil_data_dir`] on Windows, or the exe directory on
/// other OSes. Used for both config.toml and the SQLite buffer so a service
/// started from `C:\Windows\System32` (the default CWD) doesn't write files
/// into a system path.
pub fn resolve_data_path(given: &str) -> String {
    let p = std::path::Path::new(given);
    if p.is_absolute() {
        return given.to_string();
    }
    if let Some(dir) = vigil_data_dir() {
        return dir.join(given).to_string_lossy().to_string();
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            return dir.join(given).to_string_lossy().to_string();
        }
    }
    given.to_string()
}

/// Resolve a config-file path. Same semantics as [`resolve_data_path`] —
/// kept as a named alias so call sites read more clearly.
///
/// Lives in the library so `windows_service.rs` (which is compiled as part of
/// the library) can call it without round-tripping through the binary.
pub fn resolve_config_path(given: &str) -> String {
    resolve_data_path(given)
}

/// Current agent <-> Hub wire protocol. Bumped whenever the register/heartbeat
/// shape changes. Hub treats unknown versions as forward-compatible best-effort.
pub const PROTOCOL_VERSION: u32 = 2;

/// Ed25519 update-signing pubkey hex, embedded at compile time (see updater.rs).
const UPDATE_PUBKEY_HEX: &str = match option_env!("VIGIL_UPDATE_PUBKEY") {
    Some(v) => v,
    None => "",
};

/// Short (first 8 hex chars of SHA-256) fingerprint of the embedded pubkey, or
/// None when no pubkey was baked in.
pub static UPDATE_PUBKEY_FINGERPRINT: Lazy<Option<String>> = Lazy::new(|| {
    if UPDATE_PUBKEY_HEX.is_empty() {
        return None;
    }
    let bytes = hex::decode(UPDATE_PUBKEY_HEX).ok()?;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(&bytes);
    Some(hex::encode(&digest[..4])) // 4 bytes = 8 hex chars
});
