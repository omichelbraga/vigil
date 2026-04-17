//! `vigil-agent doctor` — operator-friendly preflight / health check.
//!
//! Runs a series of independent checks and prints a human checklist with
//! ✅ pass / ⚠️ warn / ❌ fail markers. Each check is its own async fn
//! returning `Result<(), DoctorIssue>` so the driver can loop and print
//! status uniformly. Exit code is 0 if everything is ✅/⚠️, 1 if any ❌.
//!
//! This is intentionally network-active (DNS, TCP, TLS, HTTP) because the
//! whole point of the command is to tell an operator whether this host can
//! actually talk to the Hub.

use anyhow::Result;
use std::net::ToSocketAddrs;
use std::time::Duration;
use tokio::net::TcpStream;

use crate::config::Config;
use crate::{PROTOCOL_VERSION, UPDATE_PUBKEY_FINGERPRINT};

/// Outcome of a single doctor check. We distinguish warn/fail because some
/// checks (clock skew >30s, http:// hub_url, running as root) are advisory
/// rather than fatal.
pub enum Severity {
    Warn,
    Fail,
}

pub struct DoctorIssue {
    pub severity: Severity,
    pub message: String,
}

impl DoctorIssue {
    fn warn(msg: impl Into<String>) -> Self {
        Self { severity: Severity::Warn, message: msg.into() }
    }
    fn fail(msg: impl Into<String>) -> Self {
        Self { severity: Severity::Fail, message: msg.into() }
    }
}

/// Convert a `Result<(), String>` into the doctor status format. Helper so
/// each individual check can be written as the prompt specified:
/// `fn check_foo() -> Result<(), String>`.
fn wrap_fail(r: Result<(), String>) -> Result<(), DoctorIssue> {
    r.map_err(DoctorIssue::fail)
}

fn wrap_warn(r: Result<(), String>) -> Result<(), DoctorIssue> {
    r.map_err(DoctorIssue::warn)
}

/// Context passed between checks to avoid redoing work (e.g. parse the URL
/// once, reuse the host/port everywhere).
struct HubTarget {
    scheme: String,
    host: String,
    port: u16,
    base_http: String,
}

impl HubTarget {
    fn parse(hub_url: &str) -> Result<Self, String> {
        let s = hub_url.trim();
        let (scheme_raw, rest) = s.split_once("://").ok_or_else(|| {
            format!("hub_url '{}' has no scheme (expected https:// or wss://)", s)
        })?;
        let scheme = scheme_raw.to_ascii_lowercase();
        let authority = rest
            .split('/')
            .next()
            .ok_or_else(|| format!("hub_url '{}' has no host", s))?;
        // Strip userinfo if any — we don't support it but shouldn't crash.
        let authority = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);

        let (host, port) = if authority.starts_with('[') {
            // IPv6 literal: [::1]:443
            let end = authority
                .find(']')
                .ok_or_else(|| format!("hub_url '{}' has malformed IPv6 literal", s))?;
            let host = &authority[1..end];
            let port_part = authority[end + 1..].trim_start_matches(':');
            let port = if port_part.is_empty() {
                default_port(&scheme)
            } else {
                port_part
                    .parse::<u16>()
                    .map_err(|_| format!("hub_url '{}' has invalid port", s))?
            };
            (host.to_string(), port)
        } else if let Some((h, p)) = authority.rsplit_once(':') {
            let port = p
                .parse::<u16>()
                .map_err(|_| format!("hub_url '{}' has invalid port", s))?;
            (h.to_string(), port)
        } else {
            (authority.to_string(), default_port(&scheme))
        };

        if host.is_empty() {
            return Err(format!("hub_url '{}' has empty host", s));
        }

        // Base HTTP URL is used for the /api/health clock-skew check.
        let http_scheme = match scheme.as_str() {
            "wss" | "https" => "https",
            "ws" | "http" => "http",
            other => return Err(format!("unsupported scheme '{}' in hub_url", other)),
        };
        // Re-assemble authority without userinfo.
        let base_http = if host.contains(':') {
            // IPv6 literal needs brackets
            format!("{}://[{}]:{}", http_scheme, host, port)
        } else {
            format!("{}://{}:{}", http_scheme, host, port)
        };

        Ok(Self { scheme, host, port, base_http })
    }
}

fn default_port(scheme: &str) -> u16 {
    match scheme {
        "https" | "wss" => 443,
        "http" | "ws" => 80,
        _ => 443,
    }
}

// ---------------------------------------------------------------------------
// Individual checks. Each returns Result<(), String> as requested: Ok = pass,
// Err = failure/warn message.
// ---------------------------------------------------------------------------

fn check_config_parse(config_path: &str) -> Result<Config, String> {
    Config::load(config_path).map_err(|e| {
        format!("could not parse config at '{}': {}", config_path, e)
    })
}

fn check_hub_url_scheme(target: &HubTarget) -> Result<(), String> {
    match target.scheme.as_str() {
        "https" | "wss" => Ok(()),
        "http" | "ws" => Err(format!(
            "hub_url uses plaintext '{}' — credentials will travel in the clear",
            target.scheme
        )),
        other => Err(format!("unknown hub_url scheme '{}'", other)),
    }
}

fn check_dns_resolve(target: &HubTarget) -> Result<(), String> {
    let addr = format!("{}:{}", target.host, target.port);
    match addr.to_socket_addrs() {
        Ok(mut it) => {
            if it.next().is_some() {
                Ok(())
            } else {
                Err(format!("DNS resolver returned no addresses for '{}'", target.host))
            }
        }
        Err(e) => Err(format!("DNS resolution of '{}' failed: {}", target.host, e)),
    }
}

async fn check_tcp_connect(target: &HubTarget) -> Result<(), String> {
    let addr = format!("{}:{}", target.host, target.port);
    match tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(format!("TCP connect to {} failed: {}", addr, e)),
        Err(_) => Err(format!("TCP connect to {} timed out after 5s", addr)),
    }
}

/// Attempt a TLS handshake against the Hub. We short-circuit if the scheme
/// is plaintext (no TLS to check). When `insecure_skip_verify` is set we
/// report "skipped" so the operator sees the posture explicitly.
async fn check_tls_handshake(
    target: &HubTarget,
    insecure_skip_verify: bool,
) -> Result<(), String> {
    if target.scheme == "http" || target.scheme == "ws" {
        return Ok(()); // nothing to check, the scheme warning already covered it
    }
    if insecure_skip_verify {
        return Err("TLS verification disabled via --insecure-skip-verify".to_string());
    }

    // Use a real reqwest HEAD against /api/health — that forces the full
    // TLS chain to be walked end-to-end with the same roots the rest of the
    // agent uses, rather than hand-rolling a rustls stream and risking
    // divergence in trust stores.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("failed to build reqwest client: {}", e))?;

    let url = format!("{}/api/health", target.base_http);
    match client.get(&url).send().await {
        Ok(_) => Ok(()),
        Err(e) => {
            if e.is_connect() || e.is_timeout() {
                // TCP/DNS errors surface through other checks — focus on TLS.
                if format!("{:?}", e).to_ascii_lowercase().contains("tls")
                    || format!("{:?}", e).to_ascii_lowercase().contains("cert")
                {
                    Err(format!("TLS handshake failed: {}", e))
                } else {
                    Err(format!("could not verify TLS (network error): {}", e))
                }
            } else if e.is_builder() {
                Err(format!("TLS client build error: {}", e))
            } else {
                Err(format!("TLS handshake failed: {}", e))
            }
        }
    }
}

/// Compare local clock to Hub `Date:` header. Warn (not fail) if skew > 30s.
async fn check_clock_skew(target: &HubTarget) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .danger_accept_invalid_certs(false)
        .build()
        .map_err(|e| format!("failed to build reqwest client: {}", e))?;

    let url = format!("{}/api/health", target.base_http);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("could not reach {}: {}", url, e))?;

    let date_hdr = resp
        .headers()
        .get("date")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Hub response missing Date header".to_string())?;

    // HTTP-date is RFC 7231 / 2822 format: "Tue, 15 Nov 1994 08:12:31 GMT"
    let hub_time = chrono::DateTime::parse_from_rfc2822(date_hdr).map_err(|e| {
        format!("could not parse Hub Date header '{}': {}", date_hdr, e)
    })?;

    let now = chrono::Utc::now();
    let skew_secs = (now.timestamp() - hub_time.timestamp()).abs();
    if skew_secs > 30 {
        Err(format!(
            "clock skew vs Hub is {}s (>30s) — TLS/token validation may fail",
            skew_secs
        ))
    } else {
        Ok(())
    }
}

fn check_buffer_writable(buffer_path: &str) -> Result<(), String> {
    // If the file already exists, we just need write access to it.
    // If it doesn't, we need write access to the parent directory.
    let path = std::path::Path::new(buffer_path);
    if path.exists() {
        let probe = std::fs::OpenOptions::new()
            .append(true)
            .open(path);
        probe
            .map(|_| ())
            .map_err(|e| format!("buffer DB '{}' not writable: {}", buffer_path, e))
    } else {
        let parent = path.parent().filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| std::path::Path::new("."));
        if !parent.exists() {
            return Err(format!(
                "buffer DB parent directory '{}' does not exist",
                parent.display()
            ));
        }
        // Try creating a temp file to confirm writability.
        let probe_path = parent.join(".vigil-write-probe");
        match std::fs::File::create(&probe_path) {
            Ok(_) => {
                let _ = std::fs::remove_file(&probe_path);
                Ok(())
            }
            Err(e) => Err(format!(
                "parent directory '{}' not writable: {}",
                parent.display(),
                e
            )),
        }
    }
}

#[cfg(unix)]
fn check_not_root() -> Result<(), String> {
    // SAFETY: geteuid() is an always-safe syscall.
    let uid = unsafe { libc_geteuid() };
    if uid == 0 {
        Err("running as root — prefer a dedicated unprivileged user (with CAP_NET_RAW if ping is needed)".to_string())
    } else {
        Ok(())
    }
}

// Minimal shim to avoid pulling libc as a dep just for geteuid.
#[cfg(unix)]
extern "C" {
    fn geteuid() -> u32;
}
#[cfg(unix)]
unsafe fn libc_geteuid() -> u32 {
    geteuid()
}

#[cfg(not(unix))]
fn check_not_root() -> Result<(), String> {
    Ok(())
}

/// CAP_NET_RAW check — only meaningful on Linux. We read /proc/self/status
/// and inspect CapEff. Bit 13 = CAP_NET_RAW.
#[cfg(target_os = "linux")]
fn check_cap_net_raw() -> Result<(), String> {
    let status = std::fs::read_to_string("/proc/self/status")
        .map_err(|e| format!("could not read /proc/self/status: {}", e))?;
    let cap_line = status
        .lines()
        .find(|l| l.starts_with("CapEff:"))
        .ok_or_else(|| "CapEff missing from /proc/self/status".to_string())?;
    let hex = cap_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "malformed CapEff line".to_string())?;
    let caps = u64::from_str_radix(hex, 16)
        .map_err(|_| format!("could not parse CapEff '{}'", hex))?;
    const CAP_NET_RAW_BIT: u64 = 1 << 13;
    if caps & CAP_NET_RAW_BIT != 0 {
        Ok(())
    } else {
        Err("CAP_NET_RAW not granted — ICMP ping monitors will fall back to exec".to_string())
    }
}

#[cfg(not(target_os = "linux"))]
fn check_cap_net_raw() -> Result<(), String> {
    Ok(()) // Not applicable on Windows/macOS — treat as pass.
}

/// Is a systemd unit (linux) or Windows service (win) registered for us?
/// "Enrolled" is approximated by "config has a non-empty hub_token".
fn check_service_registered(cfg: &Config) -> Result<(), String> {
    let enrolled = !cfg.hub_token.is_empty();
    if !enrolled {
        return Err("agent not yet enrolled (no hub_token in config) — skipping service check".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        let path = std::path::Path::new("/etc/systemd/system/vigil-agent.service");
        if path.exists() {
            return Ok(());
        }
        return Err("systemd unit /etc/systemd/system/vigil-agent.service not found".to_string());
    }

    #[cfg(windows)]
    {
        use std::process::Command;
        let out = Command::new("sc.exe").args(["query", "VIGILAgent"]).output();
        match out {
            Ok(o) if o.status.success() => Ok(()),
            Ok(o) => Err(format!(
                "Windows service VIGILAgent not registered (sc query exit {})",
                o.status
            )),
            Err(e) => Err(format!("could not run sc.exe: {}", e)),
        }
    }

    #[cfg(not(any(target_os = "linux", windows)))]
    {
        Err("service registration check not supported on this OS".to_string())
    }
}

/// Human-readable summary of which Hub-initiated actions this agent will honor.
/// Rendered inside the doctor status line.
fn format_allow_actions(a: &crate::config::AllowActions) -> String {
    let mut enabled: Vec<&str> = Vec::new();
    if a.run_check_now {
        enabled.push("run_check_now");
    }
    if a.silence_check {
        enabled.push("silence_check");
    }
    if a.reload_config {
        enabled.push("reload_config");
    }
    if !a.service_restart.is_empty() {
        enabled.push("service_restart");
    }
    if a.script_monitors {
        enabled.push("script_monitors");
    }
    if a.update_now {
        enabled.push("update_now");
    }
    if enabled.is_empty() {
        "none".to_string()
    } else {
        enabled.join(", ")
    }
}

fn check_update_pubkey() -> Result<(), String> {
    match UPDATE_PUBKEY_FINGERPRINT.as_deref() {
        Some(fp) => {
            println!("    pubkey fingerprint: {}", fp);
            Ok(())
        }
        None => Err("no VIGIL_UPDATE_PUBKEY compiled in — auto-update disabled".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------

pub async fn run(config_path: &str, insecure_skip_verify: bool) -> Result<i32> {
    println!("Vigil Agent doctor — v{}", env!("CARGO_PKG_VERSION"));
    println!("Config: {}", config_path);
    println!();

    let mut any_fail = false;

    // 1. Config
    let cfg = match check_config_parse(config_path) {
        Ok(c) => {
            print_check("Config file present & parseable", Ok(()));
            c
        }
        Err(e) => {
            print_check("Config file present & parseable", Err(DoctorIssue::fail(e.clone())));
            println!();
            println!("❌ Doctor aborted — cannot continue without a valid config.");
            return Ok(1);
        }
    };

    // 2. Parse hub_url
    let target = match HubTarget::parse(&cfg.hub_url) {
        Ok(t) => {
            print_check("hub_url parseable", Ok(()));
            t
        }
        Err(e) => {
            print_check("hub_url parseable", Err(DoctorIssue::fail(e)));
            println!();
            println!("❌ Doctor aborted — invalid hub_url.");
            return Ok(1);
        }
    };

    // 3. Scheme (warn on http/ws)
    let scheme_res = wrap_warn(check_hub_url_scheme(&target));
    if let Err(ref i) = scheme_res {
        if matches!(i.severity, Severity::Fail) { any_fail = true; }
    }
    print_check("hub_url is https/wss", scheme_res);

    // 4. DNS
    let dns_res = wrap_fail(check_dns_resolve(&target));
    if dns_res.is_err() { any_fail = true; }
    print_check(&format!("DNS resolves '{}'", target.host), dns_res);

    // 5. TCP
    let tcp_res = wrap_fail(check_tcp_connect(&target).await);
    if tcp_res.is_err() { any_fail = true; }
    print_check(
        &format!("TCP connect to {}:{} (<5s)", target.host, target.port),
        tcp_res,
    );

    // 6. TLS
    let tls_res = if insecure_skip_verify {
        wrap_warn(check_tls_handshake(&target, true).await)
    } else {
        wrap_fail(check_tls_handshake(&target, false).await)
    };
    if let Err(ref i) = tls_res {
        if matches!(i.severity, Severity::Fail) { any_fail = true; }
    }
    print_check("TLS handshake", tls_res);

    // 7. Clock skew (warn)
    let skew_res = wrap_warn(check_clock_skew(&target).await);
    print_check("Clock skew vs Hub (<30s)", skew_res);

    // 8. Buffer DB writable
    let buf_res = wrap_fail(check_buffer_writable(&cfg.buffer_path));
    if buf_res.is_err() { any_fail = true; }
    print_check(
        &format!("Buffer DB path writable ({})", cfg.buffer_path),
        buf_res,
    );

    // 9. Root warn (unix)
    let root_res = wrap_warn(check_not_root());
    print_check("Not running as root", root_res);

    // 10. CAP_NET_RAW (warn)
    let cap_res = wrap_warn(check_cap_net_raw());
    print_check("CAP_NET_RAW available (ping)", cap_res);

    // 11. Service registered (warn if not enrolled, fail if enrolled+missing)
    let svc_res = check_service_registered(&cfg);
    let svc_doctor = match svc_res {
        Ok(()) => Ok(()),
        Err(msg) => {
            if cfg.hub_token.is_empty() {
                Err(DoctorIssue::warn(msg))
            } else {
                any_fail = true;
                Err(DoctorIssue::fail(msg))
            }
        }
    };
    print_check("Service registered (systemd/SCM)", svc_doctor);

    // 12. Update pubkey embedded
    let pk_res = wrap_warn(check_update_pubkey());
    print_check("Embedded update pubkey", pk_res);

    // 13. Action allowlist — informational: summarize which Hub actions this agent honors.
    print_check(
        &format!("Action allowlist loaded ({})", format_allow_actions(&cfg.allow_actions)),
        Ok(()),
    );

    println!();
    if any_fail {
        println!("❌ Doctor finished with failures.");
        Ok(1)
    } else {
        println!("✅ Doctor finished — no blocking issues.");
        Ok(0)
    }
}

/// Terminal-friendly check-line renderer.
fn print_check(label: &str, result: Result<(), DoctorIssue>) {
    match result {
        Ok(()) => println!("✅ {}", label),
        Err(issue) => match issue.severity {
            Severity::Warn => println!("⚠️  {} — {}", label, issue.message),
            Severity::Fail => println!("❌ {} — {}", label, issue.message),
        },
    }
}

/// Allow `main.rs` to surface a single JSON blob from `version --json`.
pub fn version_json() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "protocol_version": PROTOCOL_VERSION,
        "build_sha": option_env!("BUILD_SHA").unwrap_or("unknown"),
        "update_pubkey_fingerprint": UPDATE_PUBKEY_FINGERPRINT.as_deref(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}
