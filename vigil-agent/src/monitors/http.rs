use super::{CheckResult, CheckStatus, Monitor, async_trait};
use chrono::Utc;
use std::time::{Duration, Instant};

/// Monitors an HTTP/HTTPS endpoint — checks status code, response time, and optional body keyword.
pub struct HttpMonitor {
    url: String,
    expected_status: u16,
    timeout: Duration,
    body_keyword: Option<String>,
}

impl HttpMonitor {
    pub fn new(url: String, expected_status: u16, timeout_ms: u64, body_keyword: Option<String>) -> Self {
        Self {
            url,
            expected_status,
            timeout: Duration::from_millis(timeout_ms),
            body_keyword,
        }
    }
}

#[async_trait]
impl Monitor for HttpMonitor {
    async fn check(&self) -> CheckResult {
        let start = Instant::now();

        let client = reqwest::Client::builder()
            .timeout(self.timeout)
            .danger_accept_invalid_certs(false)
            .build();

        let client = match client {
            Ok(c) => c,
            Err(e) => {
                return CheckResult {
                    monitor_name: format!("http:{}", self.url),
                    monitor_type: "http".to_string(),
                    status: CheckStatus::Unknown,
                    message: format!("Failed to build HTTP client: {e}"),
                    response_time_ms: None,
                    timestamp: Utc::now(),
                };
            }
        };

        let response = client.get(&self.url).send().await;
        let elapsed = start.elapsed().as_millis() as u64;

        let (status, message) = match response {
            Ok(resp) => {
                let status_code = resp.status().as_u16();
                if status_code != self.expected_status {
                    (
                        CheckStatus::Critical,
                        format!(
                            "{} returned status {status_code}, expected {}",
                            self.url, self.expected_status
                        ),
                    )
                } else if let Some(ref keyword) = self.body_keyword {
                    match resp.text().await {
                        Ok(body) => {
                            if body.contains(keyword.as_str()) {
                                (CheckStatus::Ok, format!("{} is healthy", self.url))
                            } else {
                                (
                                    CheckStatus::Warning,
                                    format!(
                                        "{} returned {status_code} but body missing keyword '{keyword}'",
                                        self.url
                                    ),
                                )
                            }
                        }
                        Err(e) => (
                            CheckStatus::Warning,
                            format!("{} returned {status_code} but failed to read body: {e}", self.url),
                        ),
                    }
                } else {
                    (CheckStatus::Ok, format!("{} returned {status_code}", self.url))
                }
            }
            Err(e) => (
                CheckStatus::Critical,
                format!("{} request failed: {e}", self.url),
            ),
        };

        CheckResult {
            monitor_name: format!("http:{}", self.url),
            monitor_type: "http".to_string(),
            status,
            message,
            response_time_ms: Some(elapsed),
            timestamp: Utc::now(),
        }
    }
}
