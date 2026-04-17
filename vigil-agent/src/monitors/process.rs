use super::{CheckResult, CheckStatus, Monitor, async_trait};
use chrono::Utc;
use std::time::Instant;
use sysinfo::System;

/// Monitors that a named process has at least `min_instances` running.
/// Matches by process name (case-sensitive, exact name match as reported by
/// the OS — basename, not full path).
pub struct ProcessMonitor {
    process_name: String,
    min_instances: u32,
}

impl ProcessMonitor {
    pub fn new(process_name: String, min_instances: u32) -> Self {
        Self {
            process_name,
            min_instances: min_instances.max(1),
        }
    }
}

#[async_trait]
impl Monitor for ProcessMonitor {
    async fn check(&self) -> CheckResult {
        let start = Instant::now();
        let name = self.process_name.clone();
        let min = self.min_instances;

        // sysinfo process enumeration is blocking; run off the tokio worker
        // thread so we don't stall other async tasks.
        let snapshot = tokio::task::spawn_blocking(move || {
            let mut sys = System::new();
            sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

            let mut count: u32 = 0;
            let mut total_cpu: f32 = 0.0;
            let mut total_mem_bytes: u64 = 0;

            for (_pid, proc_) in sys.processes() {
                // Process::name() returns an OsStr — compare as lossy str.
                let pname = proc_.name().to_string_lossy();
                if pname == name {
                    count = count.saturating_add(1);
                    total_cpu += proc_.cpu_usage();
                    total_mem_bytes = total_mem_bytes.saturating_add(proc_.memory());
                }
            }

            (count, total_cpu, total_mem_bytes)
        })
        .await;

        let (count, total_cpu, total_mem_bytes) = match snapshot {
            Ok(tuple) => tuple,
            Err(e) => {
                return CheckResult {
                    monitor_name: format!("process:{}", self.process_name),
                    monitor_type: "process".to_string(),
                    status: CheckStatus::Unknown,
                    message: format!("process scan task failed: {e}"),
                    response_time_ms: Some(start.elapsed().as_millis() as u64),
                    metadata: None,
                    timestamp: Utc::now(),
                };
            }
        };

        let total_ram_mb = (total_mem_bytes as f64) / (1024.0 * 1024.0);

        let (status, message) = if count == 0 {
            (
                CheckStatus::Critical,
                format!("process '{}' not running (expected ≥{})", self.process_name, min),
            )
        } else if count < min {
            (
                CheckStatus::Warning,
                format!(
                    "process '{}' only has {} instance(s) (expected ≥{})",
                    self.process_name, count, min
                ),
            )
        } else {
            (
                CheckStatus::Ok,
                format!(
                    "process '{}' running: {} instance(s), {:.1}% CPU, {:.1} MB RAM",
                    self.process_name, count, total_cpu, total_ram_mb
                ),
            )
        };

        let meta = serde_json::json!({
            "process_name": self.process_name,
            "min_instances": min,
            "count": count,
            "total_cpu_pct": total_cpu,
            "total_ram_mb": total_ram_mb,
        });

        CheckResult {
            monitor_name: format!("process:{}", self.process_name),
            monitor_type: "process".to_string(),
            status,
            message,
            response_time_ms: Some(start.elapsed().as_millis() as u64),
            metadata: Some(meta),
            timestamp: Utc::now(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_process_reports_critical() {
        let mon = ProcessMonitor::new("definitely-not-a-real-process-xyzzy".to_string(), 1);
        let r = mon.check().await;
        assert!(matches!(r.status, CheckStatus::Critical));
    }
}
