//! Autostart registration.
//!
//! * Windows — HKCU `Software\Microsoft\Windows\CurrentVersion\Run`
//! * Linux   — `~/.config/autostart/vigil-tray.desktop`
//!
//! Exposes a cross-platform `Autostart` trait with `register` /
//! `unregister` / `is_registered`. `ensure_first_run` is the entry
//! point from `main`: it registers the autostart on the first launch,
//! unless the user has dropped a `tray-no-autostart` marker file.

use anyhow::{Context, Result};
use std::path::PathBuf;

pub trait Autostart {
    fn register(&self) -> Result<()>;
    fn unregister(&self) -> Result<()>;
    fn is_registered(&self) -> Result<bool>;
}

const APP_KEY: &str = "VigilTray";

fn opt_out_flag() -> Option<PathBuf> {
    let dirs = directories::ProjectDirs::from("com", "vigil", "vigil")?;
    Some(dirs.config_dir().join("tray-no-autostart"))
}

/// First-run hook. Registers autostart unless already registered or
/// the user has opted out.
pub fn ensure_first_run() {
    // User opt-out wins.
    if let Some(flag) = opt_out_flag() {
        if flag.exists() {
            tracing::debug!(path = %flag.display(), "autostart opt-out flag present — skipping");
            return;
        }
    }

    let a = current_platform();
    match a.is_registered() {
        Ok(true) => {
            tracing::debug!("autostart already registered");
        }
        Ok(false) => match a.register() {
            Ok(()) => tracing::info!("autostart registered on first run"),
            Err(e) => tracing::warn!(error = %e, "autostart registration failed"),
        },
        Err(e) => tracing::warn!(error = %e, "autostart check failed"),
    }
}

/// Factory — returns the right impl for the host.
pub fn current_platform() -> Box<dyn Autostart> {
    #[cfg(windows)] { Box::new(windows_impl::WindowsAutostart) }
    #[cfg(unix)]    { Box::new(linux_impl::LinuxAutostart) }
}

// =========================================================================
// Linux — XDG autostart desktop entry
// =========================================================================
#[cfg(unix)]
mod linux_impl {
    use super::*;
    use std::fs;

    pub struct LinuxAutostart;

    fn desktop_path() -> Option<PathBuf> {
        let dirs = directories::BaseDirs::new()?;
        Some(dirs.config_dir().join("autostart").join("vigil-tray.desktop"))
    }

    fn exe_path() -> Result<PathBuf> {
        std::env::current_exe().context("resolve current exe")
    }

    impl Autostart for LinuxAutostart {
        fn register(&self) -> Result<()> {
            let path = desktop_path().context("no XDG config dir")?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).context("mkdir autostart")?;
            }
            let exe = exe_path()?;
            let entry = format!(
                "[Desktop Entry]\n\
                 Type=Application\n\
                 Name=Vigil Tray\n\
                 Comment=Vigil infra monitoring tray\n\
                 Exec=\"{}\" --minimized\n\
                 Icon=vigil\n\
                 Terminal=false\n\
                 X-GNOME-Autostart-enabled=true\n\
                 X-KDE-autostart-phase=2\n",
                exe.display()
            );
            fs::write(&path, entry)
                .with_context(|| format!("write {}", path.display()))?;
            Ok(())
        }

        fn unregister(&self) -> Result<()> {
            let path = desktop_path().context("no XDG config dir")?;
            if path.exists() {
                fs::remove_file(&path)
                    .with_context(|| format!("remove {}", path.display()))?;
            }
            Ok(())
        }

        fn is_registered(&self) -> Result<bool> {
            let path = desktop_path().context("no XDG config dir")?;
            Ok(path.exists())
        }
    }
}

// =========================================================================
// Windows — HKCU Run key
// =========================================================================
#[cfg(windows)]
mod windows_impl {
    use super::*;
    use windows::core::{PCWSTR, w};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE,
        REG_SZ,
    };

    pub struct WindowsAutostart;

    const RUN_KEY: PCWSTR =
        w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");

    fn exe_command() -> Result<Vec<u16>> {
        let exe = std::env::current_exe().context("resolve current exe")?;
        // Quote the path and add `--minimized` so first launch from
        // the Run key goes straight to the tray without a visible window.
        let cmd = format!("\"{}\" --minimized", exe.display());
        let mut wide: Vec<u16> = cmd.encode_utf16().collect();
        wide.push(0);
        Ok(wide)
    }

    fn to_wide(s: &str) -> Vec<u16> {
        let mut v: Vec<u16> = s.encode_utf16().collect();
        v.push(0);
        v
    }

    impl Autostart for WindowsAutostart {
        fn register(&self) -> Result<()> {
            unsafe {
                let mut hkey = HKEY::default();
                let rc = RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    RUN_KEY,
                    0,
                    PCWSTR::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_WRITE,
                    None,
                    &mut hkey,
                    None,
                );
                rc.ok().context("RegCreateKeyExW HKCU\\...\\Run")?;

                let value_name = to_wide(APP_KEY);
                let cmd        = exe_command()?;
                let cmd_bytes: &[u8] = std::slice::from_raw_parts(
                    cmd.as_ptr() as *const u8,
                    cmd.len() * 2,
                );
                let rc = RegSetValueExW(
                    hkey,
                    PCWSTR(value_name.as_ptr()),
                    0,
                    REG_SZ,
                    Some(cmd_bytes),
                );
                let _ = RegCloseKey(hkey);
                rc.ok().context("RegSetValueExW VigilTray")?;
            }
            Ok(())
        }

        fn unregister(&self) -> Result<()> {
            unsafe {
                let mut hkey = HKEY::default();
                let rc = RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    RUN_KEY,
                    0,
                    KEY_WRITE,
                    &mut hkey,
                );
                if rc.is_err() {
                    return Ok(()); // key doesn't exist — treat as not registered
                }
                let value_name = to_wide(APP_KEY);
                let _ = RegDeleteValueW(hkey, PCWSTR(value_name.as_ptr()));
                let _ = RegCloseKey(hkey);
            }
            Ok(())
        }

        fn is_registered(&self) -> Result<bool> {
            unsafe {
                let mut hkey = HKEY::default();
                let rc = RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    RUN_KEY,
                    0,
                    KEY_READ,
                    &mut hkey,
                );
                if rc.is_err() {
                    return Ok(false);
                }
                let value_name = to_wide(APP_KEY);
                let rc = RegQueryValueExW(
                    hkey,
                    PCWSTR(value_name.as_ptr()),
                    None,
                    None,
                    None,
                    None,
                );
                let _ = RegCloseKey(hkey);
                Ok(rc.is_ok())
            }
        }
    }
}
