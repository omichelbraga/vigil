use serde::Deserialize;

/// Top-level agent configuration, loaded from TOML and overridden by CLI args.
#[derive(Debug, Deserialize)]
pub struct Config {
    #[serde(default = "default_hub_url")]
    pub hub_url: String,

    #[serde(default)]
    pub hub_token: String,

    #[serde(default = "default_agent_name")]
    pub agent_name: String,

    #[serde(default)]
    pub auto_update: bool,

    #[serde(default = "default_buffer_path")]
    pub buffer_path: String,

    #[serde(default = "default_check_interval")]
    pub check_interval_secs: u64,

    #[serde(default)]
    pub monitors: MonitorsConfig,
}

#[derive(Debug, Default, Deserialize)]
pub struct MonitorsConfig {
    #[serde(default)]
    pub services: Vec<String>,

    #[serde(default)]
    pub ports: Vec<PortCheck>,

    #[serde(default)]
    pub http: Vec<HttpCheck>,

    #[serde(default)]
    pub ping: Vec<String>,

    #[serde(default)]
    pub certs: Vec<CertCheck>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct PortCheck {
    pub host: String,
    pub port: u16,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct HttpCheck {
    pub url: String,
    #[serde(default = "default_expected_status")]
    pub expected_status: u16,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    pub body_keyword: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CertCheck {
    pub host: String,
    pub port: Option<u16>,
    pub warn_days: Option<u32>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            hub_url: default_hub_url(),
            hub_token: String::new(),
            agent_name: default_agent_name(),
            auto_update: false,
            buffer_path: default_buffer_path(),
            check_interval_secs: default_check_interval(),
            monitors: MonitorsConfig::default(),
        }
    }
}

impl Config {
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let config: Config = toml::from_str(&content)?;
        Ok(config)
    }
}

fn default_hub_url() -> String {
    "wss://localhost:3000/ws".to_string()
}

fn default_agent_name() -> String {
    hostname()
}

fn default_buffer_path() -> String {
    "vigil-buffer.db".to_string()
}

fn default_check_interval() -> u64 {
    30
}

fn default_timeout() -> u64 {
    5000
}

fn default_expected_status() -> u16 {
    200
}

fn hostname() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "unknown".to_string())
}
