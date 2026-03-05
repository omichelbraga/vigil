# Check Types Reference

Checks are defined via the Hub UI (Checks page) and pushed to agents automatically. They can also be defined in the agent's `config.toml`.

## HTTP

Performs an HTTP/HTTPS GET request and validates the response.

| Field | Required | Description |
|-------|----------|-------------|
| URL | ✅ | Full URL including scheme (`https://...`) |
| Expected Status | ✅ | HTTP status code to expect (default: 200) |
| Timeout (ms) | ✅ | Request timeout in milliseconds (default: 5000) |
| Body Keyword | ❌ | Optional string that must appear in response body |

**Alert triggers:**
- Status code doesn't match expected
- Request times out
- Body keyword not found (if set)
- TLS/DNS errors

---

## Port

Opens a TCP connection to verify a port is reachable.

| Field | Required | Description |
|-------|----------|-------------|
| Host | ✅ | Hostname or IP address |
| Port | ✅ | TCP port number |
| Timeout (ms) | ✅ | Connection timeout (default: 3000) |

**Alert triggers:**
- Connection refused
- Timeout

---

## Ping

Sends ICMP echo requests to a host.

| Field | Required | Description |
|-------|----------|-------------|
| Host/IP | ✅ | Hostname or IP address |

**Alert triggers:**
- No response (host unreachable)

> Note: Requires elevated privileges on some Linux systems. Use Port check as alternative if ping is blocked by firewall.

---

## Service

Checks whether a system service is running.

| Field | Required | Description |
|-------|----------|-------------|
| Service Name | ✅ | **Linux:** systemctl unit name (e.g., `nginx`, `ssh`, `cups`) |
| | | **Windows:** SCM service name (e.g., `Spooler`, `WSearch`, `WinDefend`) |

**Alert triggers:**
- Service is stopped/inactive

**Finding service names:**
```bash
# Linux
systemctl list-units --type=service --state=running

# Windows (PowerShell)
Get-Service | Where-Object {$_.Status -eq 'Running'} | Select Name, DisplayName
```

> **Important:** Use the **service name** (e.g., `Spooler`), NOT the display name (e.g., `Print Spooler`). The Hub's "Check Name" field is for display and can be anything — only the "Service Name" in the config matters.

---

## Certificate (TLS)

Checks a domain's TLS certificate validity and expiration.

| Field | Required | Description |
|-------|----------|-------------|
| Domain | ✅ | Hostname to check (e.g., `example.com`) |
| Port | ✅ | HTTPS port (default: 443) |
| Warn Days | ✅ | Days before expiry to start warning (default: 30) |

**Alert behavior:**
- **Nothing** when cert is valid and not approaching expiry
- **Warning** when cert expires within `warn_days`
- **Critical** when cert is expired
- **No recovery notification** — cert monitors are silently resolved when renewed

**Note:** This is for TLS certificate checks on live endpoints. For Azure App Secrets, SAML certificates, or other non-HTTP credentials, use **Expiry Monitors** instead.

---

## Resource

Monitors host CPU, RAM, and disk utilization.

| Field | Required | Description |
|-------|----------|-------------|
| CPU Alert % | ✅ | CPU usage threshold (default: 90%) |
| RAM Alert % | ✅ | RAM usage threshold (default: 85%) |
| Disk Alert % | ✅ | Disk usage threshold (default: 90%) |

**Alert triggers:**
- CPU/RAM/Disk usage exceeds the configured threshold

Only one resource check is needed per agent (covers all three metrics).

---

## Expiry Monitor (Hub-side)

Tracks expiration dates for credentials and certificates that don't have live endpoints. Runs on the Hub, not on agents.

| Field | Required | Description |
|-------|----------|-------------|
| Name | ✅ | Descriptive name (e.g., "IntuneAutomation App Secret") |
| Category | ✅ | `Azure App Secret`, `SAML Certificate`, or `Other` |
| Description | ❌ | App Registration ID, notes, etc. |
| Expiration Date | ✅ | When the credential expires |
| Warn Days | ✅ | Days before expiry to start warning (default: 30) |

**Alert behavior:**
- **Nothing** when valid and not approaching expiry
- **Warning** when within `warn_days` of expiry
- **Critical** when expired
- Checks every 6 hours automatically; "Check Now" button available

**Use cases:**
- Azure App Registration client secrets
- Azure AD SAML signing certificates
- SSL certificates from external CAs
- API keys with fixed expiry dates
- Domain registrations

**Finding Azure secret expiry dates:**
1. Azure Portal → App Registrations → your app → Certificates & secrets
2. Copy the expiry date shown for each client secret

**Finding SAML cert expiry dates:**
1. Azure Portal → Enterprise Applications → your app → Single sign-on
2. Section "SAML Signing Certificate" → check expiry date shown
