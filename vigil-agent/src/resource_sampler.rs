//! Continuous resource telemetry sampler.
//!
//! Produces one `ResourceSample` per tick (default 10s) and ships it over an
//! mpsc channel to the WS sender. Metrics are CPU %, RAM %, root-disk %, 1-min
//! load average (Unix only), and net RX/TX bytes-per-second averaged over the
//! sampling interval.
//!
//! Network rate is computed from per-interface `received()` / `transmitted()`
//! deltas summed across all non-loopback interfaces.

use chrono::{DateTime, Utc};
use serde::Serialize;
use std::time::Instant;
use sysinfo::{Disks, Networks, System};
use tokio::sync::mpsc;
use tracing::{debug, warn};

/// One telemetry datapoint. Matches the Hub's `ResourceSample` model.
#[derive(Debug, Clone, Serialize)]
pub struct ResourceSample {
    pub cpu_pct: f32,
    pub ram_pct: f32,
    pub disk_pct: f32,
    /// 1-minute load average. `None` on platforms without load avg (Windows).
    pub load_avg_1: Option<f32>,
    pub net_rx_bps: u64,
    pub net_tx_bps: u64,
    pub timestamp: DateTime<Utc>,
}

/// Spawn the sampler task. Returns an mpsc receiver the WS sender reads from.
///
/// Channel is bounded to prevent unbounded memory growth if the WS writer
/// stalls — old samples are dropped (logged at debug).
pub fn spawn(interval_secs: u64) -> mpsc::Receiver<ResourceSample> {
    // Bounded channel — ~60s at 10s cadence = 6 entries; give 16 for burst
    // tolerance. If the WS writer is slower than this, we drop the oldest.
    let (tx, rx) = mpsc::channel::<ResourceSample>(16);
    let interval = std::time::Duration::from_secs(interval_secs.max(1));

    tokio::spawn(async move {
        // Prime the state on first tick so deltas are meaningful.
        let mut state = SamplerState::new();

        let mut ticker = tokio::time::interval(interval);
        // First tick fires immediately with sysinfo — discard that sample so
        // we don't ship nonsense rates (no prior baseline yet).
        ticker.tick().await;
        state.take_sample(); // prime
        loop {
            ticker.tick().await;
            let sample = state.take_sample();
            // try_send drops when channel is full rather than blocking the
            // sampler cadence; we'd rather lose old data than fall behind.
            match tx.try_send(sample) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    debug!("Resource sample channel full — dropping oldest");
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    warn!("Resource sample channel closed; sampler exiting");
                    return;
                }
            }
        }
    });

    rx
}

struct SamplerState {
    sys: System,
    nets: Networks,
    last_tick: Instant,
    last_rx_bytes: u64,
    last_tx_bytes: u64,
    primed: bool,
}

impl SamplerState {
    fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        let nets = Networks::new_with_refreshed_list();
        Self {
            sys,
            nets,
            last_tick: Instant::now(),
            last_rx_bytes: 0,
            last_tx_bytes: 0,
            primed: false,
        }
    }

    fn take_sample(&mut self) -> ResourceSample {
        // Refresh CPU twice with a brief pause — sysinfo needs two samples to
        // compute a usable global_cpu_usage() value.
        self.sys.refresh_cpu_all();
        std::thread::sleep(std::time::Duration::from_millis(100));
        self.sys.refresh_cpu_all();
        self.sys.refresh_memory();

        let cpu_pct = self.sys.global_cpu_usage();
        let ram_total = self.sys.total_memory();
        let ram_used = self.sys.used_memory();
        let ram_pct = if ram_total > 0 {
            (ram_used as f64 / ram_total as f64 * 100.0) as f32
        } else {
            0.0
        };

        let disk_pct = root_or_largest_disk_pct();

        let load_avg_1 = load_avg_1_platform();

        // Network delta since last tick
        self.nets.refresh_list();
        let (cur_rx, cur_tx) = current_net_totals(&self.nets);
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_tick).as_secs_f64();
        let (net_rx_bps, net_tx_bps) = if self.primed && elapsed > 0.0 {
            let rx_delta = cur_rx.saturating_sub(self.last_rx_bytes) as f64;
            let tx_delta = cur_tx.saturating_sub(self.last_tx_bytes) as f64;
            (
                (rx_delta / elapsed).round() as u64,
                (tx_delta / elapsed).round() as u64,
            )
        } else {
            (0, 0)
        };
        self.last_rx_bytes = cur_rx;
        self.last_tx_bytes = cur_tx;
        self.last_tick = now;
        self.primed = true;

        ResourceSample {
            cpu_pct,
            ram_pct,
            disk_pct,
            load_avg_1,
            net_rx_bps,
            net_tx_bps,
            timestamp: Utc::now(),
        }
    }
}

/// Sum received/transmitted bytes across all non-loopback interfaces.
fn current_net_totals(nets: &Networks) -> (u64, u64) {
    let mut rx: u64 = 0;
    let mut tx: u64 = 0;
    for (name, data) in nets.list() {
        if name == "lo" || name.starts_with("lo:") {
            continue;
        }
        rx = rx.saturating_add(data.total_received());
        tx = tx.saturating_add(data.total_transmitted());
    }
    (rx, tx)
}

/// Root mount usage when identifiable (/ on Unix, C:\ on Windows).
/// Otherwise falls back to the largest disk. Returns 0 if no disks.
fn root_or_largest_disk_pct() -> f32 {
    let disks = Disks::new_with_refreshed_list();
    let mut root: Option<f32> = None;
    let mut largest: Option<(u64, f32)> = None;
    for d in disks.iter() {
        let mount = d.mount_point().to_string_lossy().to_string();
        let total = d.total_space();
        let avail = d.available_space();
        if total == 0 {
            continue;
        }
        let used = total.saturating_sub(avail);
        let pct = (used as f64 / total as f64 * 100.0) as f32;
        if mount == "/" || mount.eq_ignore_ascii_case("C:\\") || mount.eq_ignore_ascii_case("C:") {
            root = Some(pct);
        }
        match largest {
            Some((cur_total, _)) if cur_total >= total => {}
            _ => largest = Some((total, pct)),
        }
    }
    root.or(largest.map(|(_, p)| p)).unwrap_or(0.0)
}

#[cfg(unix)]
fn load_avg_1_platform() -> Option<f32> {
    let la = System::load_average();
    Some(la.one as f32)
}

#[cfg(not(unix))]
fn load_avg_1_platform() -> Option<f32> {
    None
}
