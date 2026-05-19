//! Tests for the Vigil data-directory + path-resolution helpers.
//!
//! The Windows branch reads `%ProgramData%` and joins `Vigil\<file>`. The
//! non-Windows branch falls back to the exe directory and the helper returns
//! `None`. Both are exercised here.

use std::env;
#[cfg(windows)]
use std::path::PathBuf;

use vigil_agent::{resolve_data_path, vigil_data_dir};

#[cfg(windows)]
#[test]
fn vigil_data_dir_uses_program_data_env() {
    // Save + restore the env var so we don't leak across tests.
    let saved = env::var_os("ProgramData");
    env::set_var("ProgramData", r"C:\TempProgramData");

    let dir = vigil_data_dir().expect("Windows always has a data dir");
    assert_eq!(dir, PathBuf::from(r"C:\TempProgramData\Vigil"));

    match saved {
        Some(v) => env::set_var("ProgramData", v),
        None => env::remove_var("ProgramData"),
    }
}

#[cfg(windows)]
#[test]
fn resolve_data_path_anchors_relative_to_program_data() {
    let saved = env::var_os("ProgramData");
    env::set_var("ProgramData", r"C:\TempProgramData");

    let resolved = resolve_data_path("vigil-buffer.db");
    assert_eq!(resolved, r"C:\TempProgramData\Vigil\vigil-buffer.db");

    // Absolute paths must pass through unchanged.
    let abs = r"D:\elsewhere\config.toml";
    assert_eq!(resolve_data_path(abs), abs);

    match saved {
        Some(v) => env::set_var("ProgramData", v),
        None => env::remove_var("ProgramData"),
    }
}

#[cfg(not(windows))]
#[test]
fn vigil_data_dir_returns_none_on_unix() {
    assert!(
        vigil_data_dir().is_none(),
        "vigil_data_dir() is Windows-only; expected None on non-Windows"
    );
}

#[cfg(not(windows))]
#[test]
fn resolve_data_path_falls_back_to_exe_dir_on_unix() {
    // On Unix, relative paths anchor against the current exe's parent dir.
    let resolved = resolve_data_path("config.toml");
    let parent = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .expect("current_exe should have a parent in cargo test");
    assert_eq!(resolved, parent.join("config.toml").to_string_lossy());

    // Absolute paths must pass through unchanged.
    let abs = "/etc/vigil/config.toml";
    assert_eq!(resolve_data_path(abs), abs);
}
