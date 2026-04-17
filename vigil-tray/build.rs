//! build.rs — generate placeholder tray icons (64x64 solid-colour discs on
//! a transparent background) if the committed PNGs are missing.
//!
//! Keeps repo small and avoids committing binary assets. Running `cargo
//! build` produces `assets/tray-icon-*.png` for the 5 status colours.
//! We do NOT use `image::Rgba` here to keep the build-script dep-set
//! minimal — just write a hand-rolled PNG using the `png` crate… except
//! we avoid adding another dep. Instead we emit a tiny uncompressed PNG
//! by hand.
//!
//! Each status colour gets its own file:
//!   gray     — no agent / unreachable IPC
//!   green    — connected + all checks OK
//!   amber    — at least one warning
//!   red      — at least one critical or agent disconnected
//!   unknown  — connected but no data yet

use std::fs;
use std::path::PathBuf;

fn main() {
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

    println!("cargo:rerun-if-changed=build.rs");
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
