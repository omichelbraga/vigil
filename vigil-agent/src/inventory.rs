//! Agent hardware inventory — a one-shot snapshot of arch, kernel, CPU, RAM,
//! disks, and network interfaces. Sent to the Hub once per session (after
//! `register`) so the Hub can display fleet hardware detail without the agent
//! having to repeat it on every heartbeat.
//!
//! All fields are best-effort. If a field can't be determined (e.g. NIC MAC on
//! a locked-down container), it falls back to `None` rather than erroring —
//! inventory is informational, not load-bearing.

use serde::Serialize;
use std::collections::HashSet;
use sysinfo::{Disks, Networks, System};

#[derive(Debug, Clone, Serialize)]
pub struct DiskInfo {
    pub mount: String,
    pub fs_type: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct NicInfo {
    pub name: String,
    pub mac: Option<String>,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentInventory {
    pub arch: String,
    pub kernel: Option<String>,
    pub cpu_model: Option<String>,
    pub cpu_count: usize,
    pub total_ram_bytes: u64,
    pub total_disk_bytes: u64,
    pub disks: Vec<DiskInfo>,
    pub nics: Vec<NicInfo>,
    /// Unix timestamp (seconds since epoch) when the host booted.
    pub boot_time: u64,
    /// Detected container runtime, if any: "docker", "podman", "lxc",
    /// "kubernetes", or None for bare-metal / VM.
    pub container: Option<String>,
}

/// Collects a snapshot of host hardware.
///
/// Safe to call on any platform; Linux-specific bits (container detection, NIC
/// parsing fallback) degrade gracefully on Windows/macOS.
pub fn collect() -> AgentInventory {
    let mut sys = System::new_all();
    sys.refresh_all();

    let arch = std::env::consts::ARCH.to_string();
    let kernel = System::kernel_version();
    let cpu_model = sys.cpus().first().map(|c| c.brand().trim().to_string());
    let cpu_count = sys.cpus().len();
    let total_ram_bytes = sys.total_memory();

    let disks = collect_disks();
    let total_disk_bytes: u64 = disks.iter().map(|d| d.total_bytes).sum();

    let nics = collect_nics();
    let boot_time = System::boot_time();
    let container = detect_container();

    AgentInventory {
        arch,
        kernel,
        cpu_model,
        cpu_count,
        total_ram_bytes,
        total_disk_bytes,
        disks,
        nics,
        boot_time,
        container,
    }
}

fn collect_disks() -> Vec<DiskInfo> {
    let disks = Disks::new_with_refreshed_list();
    let mut seen_mounts: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for d in disks.iter() {
        let mount = d.mount_point().to_string_lossy().to_string();
        // Dedupe: on Linux, bind mounts can show the same target twice.
        if !seen_mounts.insert(mount.clone()) {
            continue;
        }
        let total = d.total_space();
        let free = d.available_space();
        let fs_type = d.file_system().to_string_lossy().to_string();
        out.push(DiskInfo {
            mount,
            fs_type,
            total_bytes: total,
            free_bytes: free,
        });
    }
    out
}

fn collect_nics() -> Vec<NicInfo> {
    let nets = Networks::new_with_refreshed_list();
    let mut out = Vec::new();
    for (name, data) in nets.list() {
        // Skip obvious pseudo-interfaces that add noise.
        if name == "lo" || name.starts_with("lo:") {
            continue;
        }

        let mac = {
            let m = data.mac_address();
            if m.is_unspecified() {
                None
            } else {
                Some(format!("{}", m))
            }
        };

        let mut ipv4 = Vec::new();
        let mut ipv6 = Vec::new();
        for ipn in data.ip_networks() {
            match ipn.addr {
                std::net::IpAddr::V4(v) => ipv4.push(v.to_string()),
                std::net::IpAddr::V6(v) => ipv6.push(v.to_string()),
            }
        }

        out.push(NicInfo {
            name: name.clone(),
            mac,
            ipv4,
            ipv6,
        });
    }
    out
}

/// Best-effort container detection by scanning `/proc/1/cgroup` for well-known
/// runtime keywords. Returns the first match found so we don't double-report
/// (Kubernetes nodes typically run containerd/docker too).
fn detect_container() -> Option<String> {
    // Only meaningful on Linux — short-circuit on other platforms.
    if !cfg!(target_os = "linux") {
        return None;
    }

    let cgroup = std::fs::read_to_string("/proc/1/cgroup").ok()?;
    let lower = cgroup.to_ascii_lowercase();

    // Order matters: check Kubernetes first (it wraps docker/containerd) so
    // k8s pods don't get mislabeled as "docker".
    if lower.contains("kubepods") || lower.contains("kubernetes") {
        return Some("kubernetes".to_string());
    }
    if lower.contains("docker") {
        return Some("docker".to_string());
    }
    if lower.contains("podman") || lower.contains("libpod") {
        return Some("podman".to_string());
    }
    if lower.contains("lxc") {
        return Some("lxc".to_string());
    }
    // /.dockerenv is also a common signal even when cgroup is hidden.
    if std::path::Path::new("/.dockerenv").exists() {
        return Some("docker".to_string());
    }

    None
}
