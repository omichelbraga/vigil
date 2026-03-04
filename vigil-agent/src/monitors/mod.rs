pub mod cert;
pub mod http;
pub mod ping;
pub mod port;
pub mod resource;
pub mod service;

use chrono::{DateTime, Utc};
use serde::Serialize;

/// Status of a single check result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    Warning,
    Critical,
    Unknown,
}

/// Result of a single monitor check.
#[derive(Debug, Clone, Serialize)]
pub struct CheckResult {
    pub monitor_name: String,
    pub monitor_type: String,
    pub status: CheckStatus,
    pub message: String,
    pub response_time_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    pub timestamp: DateTime<Utc>,
}

/// Trait all monitors must implement.
#[async_trait::async_trait]
pub trait Monitor: Send + Sync {
    async fn check(&self) -> CheckResult;
}

// Re-export async_trait for use by monitor implementations.
pub use async_trait::async_trait;
