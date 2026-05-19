# Vigil Windows Installer (MSI)

The Vigil Windows agent ships as an MSI built from `vigil-agent/wix/main.wxs`
via [`cargo-wix`](https://github.com/volks73/cargo-wix). One artifact bundles
both `vigil-agent.exe` (the service) and `vigil-tray.exe` (the per-user HUD).

## Layout produced on the host

```
C:\Program Files\Vigil\         (read-only after install)
  vigil-agent.exe                 — runs as the VIGILAgent service (LocalSystem)
  vigil-tray.exe                  — auto-started for every user on login (HKLM Run)

C:\ProgramData\Vigil\           (mutable, owned by the agent — never touched by the MSI)
  config.toml                     — hub URL, agent token, monitor config
  vigil-buffer.db                 — SQLite ring buffer for offline events
  agent.log                       — rolling log file
  agent-signing-key.pem           — per-agent ed25519 key (pinned by the Hub)
```

`C:\ProgramData\Vigil\` is **not** managed by the MSI. The agent creates it
lazily on first enrollment, and the uninstaller leaves it untouched — that's
how upgrade and repair preserve the agent's identity.

## Install scenarios

| Scenario | What happens |
|----------|--------------|
| Fresh install + `VIGIL_ENROLL_TOKEN` | MSI runs `vigil-agent --enroll TOKEN --hub-url URL`. Writes `config.toml`, registers + starts the service. |
| Fresh install, no token | MSI installs the files but does NOT register the service. Admin enrolls manually: `& "C:\Program Files\Vigil\vigil-agent.exe" --enroll TOKEN --hub-url URL`. |
| Reinstall over existing config | MSI detects `C:\ProgramData\Vigil\config.toml`, skips enrollment, re-registers the service against the existing config (idempotent). Any enrollment token passed is ignored. |
| Major upgrade (higher version) | WiX `MajorUpgrade` removes the old install (service stopped first via `--remove-service`), installs the new files, re-registers the service against the existing config. |
| Uninstall | Stops + deletes the `VIGILAgent` service, removes `C:\Program Files\Vigil\`. ProgramData preserved. |

## MSI properties

Pass these as `PROP=VALUE` on the `msiexec /i` command line, or set them in
the Group Policy MSI package transform.

| Property | Required? | Description |
|----------|-----------|-------------|
| `VIGIL_ENROLL_TOKEN` | Conditional | One-shot enrollment token from the Hub. Required for fresh-install-with-enrollment. Hidden+Secure (kept out of MSI logs). |
| `VIGIL_HUB_URL`      | Conditional | Hub HTTP URL, e.g. `http://hub.example.com:3000`. Required when `VIGIL_ENROLL_TOKEN` is set. |

The properties are referenced by the `EnrollAgent` deferred custom action.
When `VIGIL_CONFIG_EXISTS` is set (auto-detected via `DirectorySearch`), the
enrollment custom action is skipped regardless of these properties.

## Building the MSI

CI builds the MSI on `windows-latest`. To build locally on Windows:

```powershell
# Prereqs (one-time)
choco install wixtoolset --version=3.14.1 -y
cargo install cargo-wix --locked --version "^0.3"

# Build both binaries first
cargo build --release --target x86_64-pc-windows-msvc -p vigil-agent
cargo build --release --target x86_64-pc-windows-msvc -p vigil-tray --features windows-all

# Then the MSI
cd vigil-agent
cargo wix --no-build --nocapture --target x86_64-pc-windows-msvc -e WixUtilExtension
```

The `WixUtilExtension` flag is required because the EnrollAgent custom
action uses `WixQuietExec64` from that extension. Output lands in
`target/wix/vigil-agent-<version>-x86_64.msi`.

## Distribution from the Hub

The Hub serves two channels:

| Endpoint | Channel | Auth | Used for |
|----------|---------|------|----------|
| `GET /api/install/agent/windows/amd64?token=<enrollment-token>` | `msi-installer` | One-shot enrollment token | First install on a new host |
| `GET /api/update/agent/<os>/<arch>/download` | `exe-update` | Per-agent bearer token | Auto-update of running agents (ed25519-signed payload) |

Upload an MSI build via **Admin → Agent Releases → Upload** and select
**Channel: msi-installer**. The MSI is **not** required to be ed25519-signed
— that signing chain only applies to the in-place-update channel.

## Fleet deployment

### Group Policy
1. Drop `vigil-agent-<version>.msi` on a UNC share (`\\fs01\deploy\vigil\`).
2. **Group Policy Management → New GPO → Computer Configuration → Software
   Installation → Assign**.
3. **Note:** GPO software installation cannot set MSI properties per host.
   Use an MST transform created with `Orca` to bake in `VIGIL_HUB_URL`.
   Token-per-host enrollment isn't compatible with GPO assignment; for GPO,
   either:
   - Push the MSI with no token, then have the agent enroll via a logon
     script that calls `vigil-agent --enroll <token>`, or
   - Use a long-lived shared enrollment token (less secure, easier).

### Intune / SCCM
The MSI installs cleanly via Intune's *Win32 app* model. Set the install
command to:
```
msiexec /i vigil-agent.msi /qn VIGIL_ENROLL_TOKEN={{token}} VIGIL_HUB_URL=http://hub.example.com:3000
```
where `{{token}}` is resolved per-host from your deployment pipeline.
Detection rule: existence of `C:\Program Files\Vigil\vigil-agent.exe`.

## Known gaps

### SmartScreen / code-signing
The MSI is **not** Authenticode-signed (no code-signing cert is configured
yet). Consequences:
- Windows SmartScreen shows a "Windows protected your PC" warning on first
  download/run.
- Some endpoint protection products may quarantine the MSI until an admin
  allow-lists the hash.

Remediation when a cert becomes available:
1. Sign the agent + tray binaries first: `signtool sign /fd SHA256 /tr ... target\x86_64-pc-windows-msvc\release\*.exe`.
2. Sign the MSI after `cargo wix` produces it: `signtool sign /fd SHA256 /tr ... target\wix\*.msi`.
3. Bake both `signtool` invocations into `.github/workflows/release-msi.yml`
   between the build and upload steps.

### ARM64
The MSI is x64-only. Building for `aarch64-pc-windows-msvc` would require
WiX `Platform="arm64"` plus a parallel cross-build of both crates.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| MSI exits 1603 immediately | Not running elevated | Re-run PowerShell as Administrator |
| MSI installs but service doesn't start | Enrollment custom action failed | Check `C:\Windows\Temp\MSI*.log` (run `msiexec /i ... /l*v install.log`). Most common: invalid token (already used / expired) |
| `Get-Service VIGILAgent` returns "service not found" after install | Custom action didn't run because both `VIGIL_ENROLL_TOKEN` is unset AND no existing config | Enroll manually: `& "C:\Program Files\Vigil\vigil-agent.exe" --enroll TOKEN --hub-url URL` |
| Upgrade MSI hangs at "stopping VIGILAgent" | Service handle leaked or watchdog respawning | Stop manually: `sc.exe stop VIGILAgent`, wait 10s, re-run MSI |
| Tray app doesn't appear on login | HKLM Run blocked by Group Policy | Launch manually from Start Menu → Vigil Tray, or remove the GP restriction |
