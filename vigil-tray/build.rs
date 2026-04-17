//! build.rs — two responsibilities:
//!
//! 1. Generate placeholder tray icons (64×64 solid-colour discs on a
//!    transparent background) if the committed PNGs are missing. Hand-
//!    rolled PNG encoder keeps this dep-free.
//!
//! 2. **Windows only**: download the Microsoft.Web.WebView2 NuGet package,
//!    extract `runtimes/win-x64/native/WebView2Loader.dll`, and copy it
//!    next to the produced `vigil-tray.exe` so the wry HUD works out of
//!    the box for MinGW-cross-compiled binaries. On non-Windows targets
//!    this step short-circuits immediately.
//!
//! Each status colour gets its own file:
//!   gray     — no agent / unreachable IPC
//!   green    — connected + all checks OK
//!   amber    — at least one warning
//!   red      — at least one critical or agent disconnected
//!   unknown  — connected but no data yet

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

// ---- WebView2 SDK pin -----------------------------------------------------
//
// Pinned so builds are reproducible. Bump with care (verify DLL signature
// and re-measure SHA-256). The URL layout is Microsoft's official NuGet
// feed; redistribution of WebView2Loader.dll is permitted under the
// WebView2 SDK redistribution terms.
const WEBVIEW2_SDK_VERSION: &str = "1.0.2210.55";
const WEBVIEW2_SDK_URL_DEFAULT: &str =
    "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.2210.55";
/// Path inside the NuGet zip where the x64 loader lives.
const WEBVIEW2_LOADER_ZIP_PATH: &str = "runtimes/win-x64/native/WebView2Loader.dll";

fn main() {
    generate_tray_icons();

    // Only bundle the loader DLL when we're actually building for Windows.
    // `CARGO_CFG_TARGET_OS` is set by cargo to the *target* OS (not host),
    // so this correctly skips native Linux builds of vigil-tray.
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "windows" {
        if let Err(e) = bundle_webview2_loader() {
            // Soft-fail: emit a warning so the build can still proceed when
            // the developer is offline. The .exe will still compile; it
            // just won't have the DLL sibling and will error at runtime
            // unless the operator drops one in manually.
            println!(
                "cargo:warning=vigil-tray: failed to bundle WebView2Loader.dll: {e}. \
                 HUD will not launch on target machines without a manually-placed DLL."
            );
        }
    }

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=VIGIL_WEBVIEW2_SDK_URL");
    println!("cargo:rerun-if-env-changed=VIGIL_WEBVIEW2_SKIP_BUNDLE");
}

// =========================================================================
// WebView2 loader bundling
// =========================================================================

fn bundle_webview2_loader() -> Result<(), String> {
    if env::var("VIGIL_WEBVIEW2_SKIP_BUNDLE").is_ok() {
        println!("cargo:warning=vigil-tray: VIGIL_WEBVIEW2_SKIP_BUNDLE set; skipping DLL bundle");
        return Ok(());
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").map_err(|e| e.to_string())?);
    let sdk_dir = out_dir.join("webview2-sdk");
    fs::create_dir_all(&sdk_dir).map_err(|e| format!("mkdir {}: {e}", sdk_dir.display()))?;

    let version_sentinel = sdk_dir.join(".version");
    let cached_dll = sdk_dir.join("WebView2Loader.dll");

    // Cache hit: sentinel matches pinned version AND cached DLL exists.
    let fresh = cached_dll.is_file()
        && fs::read_to_string(&version_sentinel)
            .map(|s| s.trim() == WEBVIEW2_SDK_VERSION)
            .unwrap_or(false);

    if !fresh {
        let url = env::var("VIGIL_WEBVIEW2_SDK_URL")
            .unwrap_or_else(|_| WEBVIEW2_SDK_URL_DEFAULT.to_string());
        let nupkg_path = sdk_dir.join(format!("microsoft.web.webview2.{WEBVIEW2_SDK_VERSION}.nupkg"));
        download_with_curl(&url, &nupkg_path)?;
        extract_loader_from_nupkg(&nupkg_path, &cached_dll)?;
        fs::write(&version_sentinel, WEBVIEW2_SDK_VERSION)
            .map_err(|e| format!("write sentinel {}: {e}", version_sentinel.display()))?;
        // Drop the zip once we've pulled the DLL out — keeps the cache lean.
        let _ = fs::remove_file(&nupkg_path);
    }

    // Always mirror into $OUT_DIR/WebView2Loader.dll (handy if Rust code
    // ever wants to `include_bytes!(concat!(env!("OUT_DIR"), ...))` it).
    let out_dll = out_dir.join("WebView2Loader.dll");
    fs::copy(&cached_dll, &out_dll)
        .map_err(|e| format!("copy to {}: {e}", out_dll.display()))?;

    // Copy next to the produced .exe. Cargo doesn't expose the final
    // artifact path to build scripts, but OUT_DIR is always of the form:
    //   <target_dir>/[<triple>/]<profile>/build/<crate>-<hash>/out
    // Walking up 3 levels lands us in the profile dir where the .exe ends
    // up (e.g. target/x86_64-pc-windows-gnu/release/).
    if let Some(profile_dir) = out_dir.ancestors().nth(3) {
        let sibling = profile_dir.join("WebView2Loader.dll");
        fs::copy(&cached_dll, &sibling)
            .map_err(|e| format!("copy to {}: {e}", sibling.display()))?;
        println!("cargo:warning=vigil-tray: WebView2Loader.dll bundled at {}", sibling.display());
    }

    Ok(())
}

/// Shell out to `curl` to grab the NuGet package. Keeping this to a single
/// spawn-process call lets us avoid pulling reqwest/ureq/rustls into the
/// build graph. `curl` is ubiquitous on dev machines; failure mode is
/// reported clearly.
fn download_with_curl(url: &str, dest: &Path) -> Result<(), String> {
    let status = Command::new("curl")
        .arg("--fail")
        .arg("--location")
        .arg("--silent")
        .arg("--show-error")
        .arg("--output")
        .arg(dest)
        .arg(url)
        .status()
        .map_err(|e| {
            format!(
                "could not spawn `curl` — install it or set VIGIL_WEBVIEW2_SKIP_BUNDLE=1 to opt out: {e}"
            )
        })?;
    if !status.success() {
        return Err(format!("curl exited with {status} fetching {url}"));
    }
    Ok(())
}

/// Pop open the `.nupkg` (just a ZIP file) and extract the one entry we
/// care about — the x64 loader DLL.
fn extract_loader_from_nupkg(nupkg: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(nupkg)
        .map_err(|e| format!("open {}: {e}", nupkg.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("parse nupkg as zip: {e}"))?;

    let mut entry = archive
        .by_name(WEBVIEW2_LOADER_ZIP_PATH)
        .map_err(|e| format!("nupkg missing {WEBVIEW2_LOADER_ZIP_PATH}: {e}"))?;

    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut buf)
        .map_err(|e| format!("read {WEBVIEW2_LOADER_ZIP_PATH}: {e}"))?;

    let mut f = fs::File::create(dest)
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    f.write_all(&buf)
        .map_err(|e| format!("write {}: {e}", dest.display()))?;
    Ok(())
}

// =========================================================================
// Tray icon generation — unchanged, pre-existing logic
// =========================================================================

fn generate_tray_icons() {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets");
    fs::create_dir_all(&out).expect("mkdir assets");

    let variants: &[(&str, [u8; 4])] = &[
        ("tray-icon-gray.png",    [0x80, 0x80, 0x80, 0xFF]),
        ("tray-icon-ok.png",      [0x2E, 0xCC, 0x71, 0xFF]),
        ("tray-icon-amber.png",   [0xF3, 0x9C, 0x12, 0xFF]),
        ("tray-icon-red.png",     [0xE7, 0x4C, 0x3C, 0xFF]),
        ("tray-icon-unknown.png", [0x3D, 0x91, 0xC7, 0xFF]),
    ];

    for (name, rgba) in variants {
        let path = out.join(name);
        if path.exists() {
            continue;
        }
        let bytes = render_disc_png(64, 64, *rgba);
        fs::write(&path, bytes).unwrap_or_else(|e| {
            panic!("write tray icon {}: {}", path.display(), e);
        });
    }
}

/// Produce an RGBA PNG of a filled circle centred in the image.
/// Hand-rolled so build.rs stays dependency-free.
fn render_disc_png(w: u32, h: u32, rgba: [u8; 4]) -> Vec<u8> {
    // 1. rasterise into a raw RGBA8 buffer
    let cx = w as f32 / 2.0 - 0.5;
    let cy = h as f32 / 2.0 - 0.5;
    let r  = (w.min(h) as f32 / 2.0) - 2.0;

    let mut raw = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let d  = (dx * dx + dy * dy).sqrt();
            if d <= r {
                raw.extend_from_slice(&rgba);
            } else {
                raw.extend_from_slice(&[0, 0, 0, 0]);
            }
        }
    }

    // 2. wrap into a PNG. Since pulling `png` as a build-dep is
    //    heavy, we emit an uncompressed BMP-esque payload inside a
    //    single-chunk PNG by leveraging zlib's store mode manually.
    encode_png_uncompressed(w, h, &raw)
}

/// Minimal PNG encoder — 8-bit truecolor+alpha, filter-none, uncompressed
/// (zlib stored-block mode). Good enough for 64x64 icons.
fn encode_png_uncompressed(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba.len() + 128);
    out.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG sig

    // IHDR
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.push(8);       // bit depth
    ihdr.push(6);       // colour type: RGBA
    ihdr.push(0);       // compression
    ihdr.push(0);       // filter
    ihdr.push(0);       // interlace
    write_chunk(&mut out, b"IHDR", &ihdr);

    // IDAT — stream of filter-none scanlines, zlib-stored
    let mut raw_with_filter = Vec::with_capacity(rgba.len() + h as usize);
    for y in 0..h {
        raw_with_filter.push(0u8); // filter = None
        let start = (y * w * 4) as usize;
        let end   = start + (w * 4) as usize;
        raw_with_filter.extend_from_slice(&rgba[start..end]);
    }

    let zlib = zlib_store(&raw_with_filter);
    write_chunk(&mut out, b"IDAT", &zlib);

    // IEND
    write_chunk(&mut out, b"IEND", &[]);
    out
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let crc_start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[crc_start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

fn zlib_store(data: &[u8]) -> Vec<u8> {
    // zlib header: deflate, 32K window, no preset dict, fastest
    let mut out = vec![0x78, 0x01];
    // DEFLATE stored blocks — max 65535 bytes each.
    let mut i = 0;
    while i < data.len() {
        let chunk_len = (data.len() - i).min(0xFFFF);
        let is_last = i + chunk_len == data.len();
        out.push(if is_last { 0x01 } else { 0x00 }); // BFINAL + BTYPE=00
        let l = chunk_len as u16;
        out.extend_from_slice(&l.to_le_bytes());
        out.extend_from_slice(&(!l).to_le_bytes());
        out.extend_from_slice(&data[i..i + chunk_len]);
        i += chunk_len;
    }
    // Adler-32 trailer
    let a = adler32(data);
    out.extend_from_slice(&a.to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65521;
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
        a = (a + x as u32) % MOD;
        b = (b + a) % MOD;
    }
    (b << 16) | a
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFFFFFFu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB88320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    c ^ 0xFFFFFFFF
}
