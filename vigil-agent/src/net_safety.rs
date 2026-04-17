//! Helpers for refusing to probe internal/private networks.
//!
//! A compromised Hub should not be able to weaponise the agent as an internal
//! network scanner. By default the agent refuses any http/port/ping target
//! that resolves to a loopback, RFC1918, link-local, CGNAT, or multicast
//! address. Set `VIGIL_ALLOW_INTERNAL_NET=1` at the monitored host to opt in
//! when the agent legitimately needs to probe internal services.
//!
//! The checks are intentionally string/IP-based — no DNS lookup is performed
//! here because (a) the connect/probe layer will resolve anyway, and (b) we
//! don't want to add a pre-flight RTT to every check. Monitors that accept
//! hostnames should call `host_allowed(host)` which rejects obvious literals
//! and the `localhost`/`*.local` family; the OS resolver will still refuse
//! to connect if the resolved IP happens to be private, but the first line of
//! defence is literal-string rejection.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

pub fn internal_net_allowed() -> bool {
    matches!(std::env::var("VIGIL_ALLOW_INTERNAL_NET").as_deref(), Ok("1"))
}

fn ipv4_is_private(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_unspecified()
        // 100.64.0.0/10 CGNAT
        || (ip.octets()[0] == 100 && (ip.octets()[1] & 0xc0) == 0x40)
}

fn ipv6_is_private(ip: Ipv6Addr) -> bool {
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        // Unique local fc00::/7
        || (ip.segments()[0] & 0xfe00) == 0xfc00
        // Link-local fe80::/10
        || (ip.segments()[0] & 0xffc0) == 0xfe80
}

/// Returns true when the target is safe to probe (external).
pub fn host_allowed(host: &str) -> bool {
    if internal_net_allowed() {
        return true;
    }
    let h = host.trim().trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if h.is_empty() {
        return false;
    }
    if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") {
        return false;
    }
    if let Ok(v4) = Ipv4Addr::from_str(&h) {
        return !ipv4_is_private(v4);
    }
    if let Ok(v6) = Ipv6Addr::from_str(&h) {
        return !ipv6_is_private(v6);
    }
    if let Ok(ip) = IpAddr::from_str(&h) {
        return match ip {
            IpAddr::V4(v) => !ipv4_is_private(v),
            IpAddr::V6(v) => !ipv6_is_private(v),
        };
    }
    // Non-literal hostname — defer to the resolver. We still reject empty and
    // obvious local suffixes above.
    true
}

/// Returns true when the URL is safe to probe.
pub fn url_allowed(url: &str) -> bool {
    if internal_net_allowed() {
        return true;
    }
    // Only http(s) — refuse file://, gopher://, etc.
    let scheme_end = match url.find("://") {
        Some(i) => i,
        None => return false,
    };
    let scheme = &url[..scheme_end];
    if scheme != "http" && scheme != "https" {
        return false;
    }
    let rest = &url[scheme_end + 3..];
    let host_end = rest
        .find(|c: char| c == '/' || c == '?' || c == '#')
        .unwrap_or(rest.len());
    let authority = &rest[..host_end];
    // Strip credentials
    let host_part = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    // Strip port
    let host = if host_part.starts_with('[') {
        // IPv6 [::1]:443
        host_part
            .split_once(']')
            .map(|(h, _)| h.trim_start_matches('['))
            .unwrap_or(host_part)
    } else {
        host_part.rsplit_once(':').map(|(h, _)| h).unwrap_or(host_part)
    };
    host_allowed(host)
}

/// Returns true if a ping/port target is a valid non-flag, non-empty string.
/// Leading `-` is rejected to block argument injection into ping / sc / etc.
pub fn safe_argv_target(target: &str) -> bool {
    !target.is_empty() && !target.starts_with('-')
}
