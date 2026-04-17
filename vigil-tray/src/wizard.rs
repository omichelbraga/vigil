//! First-run enrollment wizard helpers.
//!
//! Most of the UI lives in `hud.rs` (it's a webview) — this module holds
//! the pure-logic helpers: detecting "no agent present", hitting the
//! hub's /api/health probe, and spawning `vigil-agent --enroll` with the
//! arguments the wizard collected.

use std::path::PathBuf;
#[cfg(unix)]
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result};
use tracing::{debug, info};

/// Returns true if the wizard should launch — no running agent AND no
/// persistent config file on disk suggests a fresh install.
pub async fn should_show_wizard() -> bool {
    let ipc_ok = crate::ipc_client::call("get_status", serde_json::json!({}))
        .await
        .is_ok();
    if ipc_ok {
        return false;
    }
    !agent_config_exists()
}

fn agent_config_exists() -> bool {
    for p in candidate_config_paths() {
        if p.exists() {
            debug!(path = %p.display(), "agent config found");
            return true;
        }
    }
    false
}

fn candidate_config_paths() -> Vec<PathBuf> {
    let mut v = Vec::new();

    #[cfg(unix)]
    {
        v.push(PathBuf::from("/etc/vigil/agent.toml"));
        v.push(PathBuf::from("/etc/vigil-agent.toml"));
        if let Some(dirs) = directories::BaseDirs::new() {
            v.push(dirs.config_dir().join("vigil").join("agent.toml"));
        }
    }
    #[cfg(windows)]
    {
        if let Ok(pd) = std::env::var("PROGRAMDATA") {
            v.push(PathBuf::from(pd).join("Vigil").join("agent.toml"));
        }
        if let Some(dirs) = directories::BaseDirs::new() {
            v.push(dirs.config_dir().join("vigil").join("agent.toml"));
        }
    }
    v
}

/// Attempt to locate the `vigil-agent` binary.
///
/// Search order:
///   1. Next to vigil-tray(.exe) — bundled-install case
///   2. Well-known system install locations (admin-install path on Windows,
///      /opt /usr/local on Unix)
///   3. Windows SCM `ImagePath` for the `VIGILAgent` service
///   4. `PATH`
pub fn find_agent_binary() -> Result<PathBuf> {
    #[cfg(windows)] let name = "vigil-agent.exe";
    #[cfg(unix)]    let name = "vigil-agent";

    // 1. Next to the tray exe
    let mut me = std::env::current_exe().context("current exe")?;
    me.pop();
    let candidate = me.join(name);
    if candidate.exists() {
        return Ok(candidate);
    }

    // 2. Standard install locations
    #[cfg(windows)]
    let well_known: &[&str] = &[
        r"C:\Program Files\Vigil\vigil-agent.exe",
        r"C:\ProgramData\Vigil\vigil-agent.exe",
        r"C:\Program Files (x86)\Vigil\vigil-agent.exe",
    ];
    #[cfg(unix)]
    let well_known: &[&str] = &[
        "/opt/vigil/vigil-agent",
        "/usr/local/bin/vigil-agent",
        "/usr/bin/vigil-agent",
    ];
    for p in well_known {
        let candidate = PathBuf::from(p);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    // 3. Windows SCM — ask the service manager where VIGILAgent lives
    #[cfg(windows)]
    if let Some(path) = query_scm_image_path("VIGILAgent") {
        if path.exists() {
            return Ok(path);
        }
    }

    // 4. PATH
    if let Ok(path) = std::env::var("PATH") {
        for p in std::env::split_paths(&path) {
            let c = p.join(name);
            if c.exists() {
                return Ok(c);
            }
        }
    }

    anyhow::bail!(
        "vigil-agent binary not found. Searched: next to vigil-tray, standard install dirs, SCM, PATH. \
         Either copy vigil-agent.exe next to vigil-tray.exe or install the agent to C:\\Program Files\\Vigil."
    )
}

/// Query the Windows SCM for a service's `ImagePath`, stripping flags and
/// quotes. Returns the .exe path if the service exists and the value parses.
#[cfg(windows)]
fn query_scm_image_path(service_name: &str) -> Option<PathBuf> {
    use std::process::Command;
    let out = Command::new("sc.exe")
        .args(["qc", service_name])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("BINARY_PATH_NAME")
            .and_then(|s| s.split(':').nth(1))
            .map(|s| s.trim())
        {
            // `BINARY_PATH_NAME     : "C:\Program Files\Vigil\vigil-agent.exe" --config "..."`
            // Take first quoted token, or up to the first space if unquoted.
            let exe = if let Some(rest) = rest.strip_prefix('"') {
                rest.split('"').next().unwrap_or(rest).to_string()
            } else {
                rest.split_whitespace().next().unwrap_or(rest).to_string()
            };
            if !exe.is_empty() {
                return Some(PathBuf::from(exe));
            }
        }
    }
    None
}

/// Hit `<hub>/api/health` and return the response body on success.
pub async fn test_connection(hub: &str) -> Result<String> {
    let url = format!("{}/api/health", hub.trim_end_matches('/'));
    test_connection_raw(&url).await
}

async fn test_connection_raw(url: &str) -> Result<String> {
    // We don't pull `reqwest` — use a bare TCP + TLS client via
    // tokio::net + a blocking spawn calling `std::net` is overkill.
    // Simplest approach that doesn't expand the dep-tree: shell out
    // to `curl` if present, else fall back to a blocking std call
    // through the `webbrowser` crate's transitive deps (ugly).
    //
    // Pragmatic choice: use blocking HTTP via a tiny helper. We
    // actually already ship `reqwest`-less, so pull a minimal HTTP
    // probe using the `std::net::TcpStream` + rustls… that's a lot
    // of code. For now, shell out to `curl`; if missing, bail with
    // a clear error the UI shows.
    let url = url.to_string();
    let out = tokio::task::spawn_blocking(move || {
        let result = Command::new("curl")
            .args(["-fsS", "--max-time", "5", &url])
            .output();
        match result {
            Ok(o) if o.status.success() => {
                Ok(String::from_utf8_lossy(&o.stdout).to_string())
            }
            Ok(o) => {
                let err = String::from_utf8_lossy(&o.stderr).to_string();
                Err(anyhow::anyhow!("curl exit {}: {err}", o.status))
            }
            Err(e) => Err(anyhow::anyhow!("curl not available: {e}")),
        }
    })
    .await
    .context("spawn_blocking failed")??;
    Ok(out)
}

/// Run `vigil-agent --enroll <token> --hub-url <url>` and capture output.
pub async fn enroll(hub: &str, token: &str) -> Result<String> {
    let bin = find_agent_binary()?;
    let hub = hub.to_string();
    let token = token.to_string();
    info!(bin = %bin.display(), %hub, "spawning vigil-agent --enroll");

    let out = tokio::task::spawn_blocking(move || {
        Command::new(bin)
            .args(["--enroll", &token, "--hub-url", &hub])
            .output()
            .context("spawn vigil-agent")
    })
    .await
    .context("spawn_blocking join failed")??;

    if !out.status.success() {
        anyhow::bail!(
            "vigil-agent --enroll exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Best-effort spawn of `vigil-agent doctor` in a visible terminal.
pub fn spawn_doctor() -> Result<()> {
    let bin = find_agent_binary()?;
    let bin_str = bin.display().to_string();

    #[cfg(windows)]
    {
        // Open in a new cmd window so the user can read the output.
        Command::new("cmd")
            .args(["/C", "start", "cmd", "/K", &format!("\"{bin_str}\" doctor")])
            .spawn()
            .context("spawn cmd doctor")?;
    }
    #[cfg(unix)]
    {
        let term = find_terminal();
        Command::new(&term)
            .args(["-e", &bin_str, "doctor"])
            .spawn()
            .with_context(|| format!("spawn {term} doctor"))?;
    }
    Ok(())
}

#[cfg(unix)]
fn find_terminal() -> String {
    // Respect $TERMINAL if set, else try the well-known candidates.
    if let Ok(t) = std::env::var("TERMINAL") {
        if !t.is_empty() && Path::new(&t).is_absolute() {
            return t;
        }
    }
    for candidate in &[
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "alacritty",
        "kitty",
        "xterm",
    ] {
        if which(candidate).is_some() {
            return candidate.to_string();
        }
    }
    "xterm".to_string()
}

#[cfg(unix)]
fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var("PATH").ok()?;
    std::env::split_paths(&path)
        .map(|p| p.join(name))
        .find(|p| p.exists())
}
