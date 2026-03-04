use super::{CheckResult, CheckStatus, Monitor, async_trait};
use chrono::Utc;
use serde::Serialize;
use std::time::Instant;
use sysinfo::System;

/// Monitors system resources: CPU, RAM, and disk usage.
pub struct ResourceMonitor {
    cpu_alert_pct: f32,
    ram_alert_pct: f32,
    disk_alert_pct: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceSnapshot {
    pub cpu_usage_pct: f32,
    pub ram_used_bytes: u64,
    pub ram_total_bytes: u64,
    pub ram_usage_pct: f32,
    pub disks: Vec<DiskInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiskInfo {
    pub mount: String,
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub usage_pct: f32,
}

impl ResourceMonitor {
    pub fn new(cpu_alert_pct: f32, ram_alert_pct: f32, disk_alert_pct: f32) -> Self {
        Self {
            cpu_alert_pct,
            ram_alert_pct,
            disk_alert_pct,
        }
    }
}

#[async_trait]
impl Monitor for ResourceMonitor {
    async fn check(&self) -> CheckResult {
        let start = Instant::now();

        let cpu_alert = self.cpu_alert_pct;
        let ram_alert = self.ram_alert_pct;
        let disk_alert = self.disk_alert_pct;

        // sysinfo needs a brief pause to collect CPU usage
        let snapshot = tokio::task::spawn_blocking(move || {
            let mut sys = System::new_all();
            std::thread::sleep(std::time::Duration::from_millis(200));
            sys.refresh_all();

            let cpu_usage_pct = sys.cpus().iter().map(|c| c.cpu_usage()).sum::<f32>()
                / sys.cpus().len().max(1) as f32;

            let ram_used = sys.used_memory();
            let ram_total = sys.total_memory();
            let ram_pct = if ram_total > 0 {
                (ram_used as f64 / ram_total as f64 * 100.0) as f32
            } else {
                0.0
            };

            let disks: Vec<DiskInfo> = sysinfo::Disks::new_with_refreshed_list()
                .iter()
                .map(|d| {
                    let total = d.total_space();
                    let available = d.available_space();
                    let used = total.saturating_sub(available);
                    let pct = if total > 0 {
                        (used as f64 / total as f64 * 100.0) as f32
                    } else {
                        0.0
                    };
                    DiskInfo {
                        mount: d.mount_point().to_string_lossy().to_string(),
                        used_bytes: used,
                        total_bytes: total,
                        usage_pct: pct,
                    }
                })
                .collect();

            (cpu_usage_pct, ram_used, ram_total, ram_pct, disks, cpu_alert, ram_alert, disk_alert)
        })
        .await
        .unwrap_or_else(|_| (0.0, 0, 0, 0.0, vec![], cpu_alert, ram_alert, disk_alert));

        let (cpu_pct, ram_used, ram_total, ram_pct, disks, cpu_thr, ram_thr, disk_thr) = snapshot;

        let mut warnings = Vec::new();
        let mut status = CheckStatus::Ok;

        if cpu_pct > cpu_thr {
            warnings.push(format!("CPU {cpu_pct:.1}% > {cpu_thr:.0}%"));
            status = CheckStatus::Warning;
        }
        if ram_pct > ram_thr {
            warnings.push(format!("RAM {ram_pct:.1}% > {ram_thr:.0}%"));
            status = CheckStatus::Warning;
        }
        for d in &disks {
            if d.usage_pct > disk_thr {
                warnings.push(format!("Disk {} {:.1}% > {:.0}%", d.mount, d.usage_pct, disk_thr));
                status = CheckStatus::Warning;
            }
        }

        // Escalate to critical if multiple thresholds breached
        if warnings.len() >= 2 {
            status = CheckStatus::Critical;
        }

        let message = if warnings.is_empty() {
            format!("CPU {cpu_pct:.1}%, RAM {ram_pct:.1}%, all normal")
        } else {
            warnings.join("; ")
        };

        let elapsed = start.elapsed().as_millis() as u64;

        let snap = ResourceSnapshot {
            cpu_usage_pct: cpu_pct,
            ram_used_bytes: ram_used,
            ram_total_bytes: ram_total,
            ram_usage_pct: ram_pct,
            disks,
        };

        CheckResult {
            monitor_name: "resource:system".to_string(),
            monitor_type: "resource".to_string(),
            status,
            message,
            response_time_ms: Some(elapsed),
            metadata: Some(serde_json::to_value(&snap).unwrap_or_default()),
            timestamp: Utc::now(),
        }
    }
}
