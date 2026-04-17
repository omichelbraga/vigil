# vigil-tray

System-tray companion for `vigil-agent`: status indicator, quick actions, and
a `wry`-backed HUD / first-run wizard.

This README covers operator-visible packaging details that matter when you
ship a build to end users. For the day-to-day developer workflow see the
top-level `README.md` and `docs/`.

## Windows build: WebView2 runtime loader

On Windows, the HUD feature (`--features hud`) uses [Microsoft's WebView2][ms-wv2]
via the `wry` crate. `wry`'s Rust bindings in turn depend on `webview2-com-sys`,
which links against Microsoft's native `WebView2Loader.dll`.

For **MSVC** Windows targets (`x86_64-pc-windows-msvc`), `webview2-com-sys`
statically links `WebView2LoaderStatic.lib` and the resulting `.exe` is a
single self-contained binary — no sibling DLL needed.

For **MinGW** Windows targets (`x86_64-pc-windows-gnu`, which is what we
cross-compile for on Linux CI), `webview2-com-sys` hard-codes a dynamic
link to `WebView2Loader.dll`. The loader DLL therefore has to ship next to
`vigil-tray.exe`.

### What `build.rs` does

When `CARGO_CFG_TARGET_OS == windows`, `build.rs`:

1. Downloads the pinned Microsoft.Web.WebView2 NuGet package (version
   `1.0.2210.55`) from `https://www.nuget.org/api/v2/package/...`.
   - Fetch is done via `curl` (shell-out) to keep build dependencies minimal.
   - URL can be overridden with `VIGIL_WEBVIEW2_SDK_URL`.
   - Downloading can be skipped entirely with `VIGIL_WEBVIEW2_SKIP_BUNDLE=1`
     (e.g. for offline CI where the DLL is provided by another means).
2. Unzips the `.nupkg` using the `zip` crate and extracts
   `runtimes/win-x64/native/WebView2Loader.dll`.
3. Caches the DLL under `$OUT_DIR/webview2-sdk/` with a `.version` sentinel,
   so subsequent builds skip the network call.
4. Copies the DLL to `target/<triple>/<profile>/WebView2Loader.dll` — right
   next to the produced `vigil-tray.exe`.

Non-Windows builds (`cargo build --target x86_64-unknown-linux-gnu`, or a
plain `cargo build` on a Linux host) short-circuit before any of this runs
and pay **no** network / zip cost.

### Shipping to end-users

Distribute **both** files together:

```
vigil-tray.exe
WebView2Loader.dll
```

They must live in the same directory on the target machine. The installer
package (MSI/Inno Setup) should stage them as a single unit.

> If your operators have the WebView2 Runtime installed system-wide and you
> build with MSVC (`--target x86_64-pc-windows-msvc`), you can ship the
> `.exe` alone because `webview2-com-sys` statically links the loader. Our
> Linux cross-compile pipeline does not use MSVC, so for that pipeline the
> sidecar DLL is mandatory.

### Build commands

MinGW cross-compile (produces `.exe` + sibling DLL):

```bash
cargo build --manifest-path vigil-tray/Cargo.toml \
    --target x86_64-pc-windows-gnu --release --features hud
# => target/x86_64-pc-windows-gnu/release/vigil-tray.exe
# => target/x86_64-pc-windows-gnu/release/WebView2Loader.dll
```

Linux native, headless (no tray, no HUD — useful for CI smoke tests):

```bash
cargo build --manifest-path vigil-tray/Cargo.toml \
    --no-default-features --release
```

### Redistribution notice

`WebView2Loader.dll` is a Microsoft redistributable. It is not committed to
this repository — `build.rs` downloads it on demand and `target/` is
gitignored. Redistribution in our own installer is permitted under the
[Microsoft WebView2 SDK Redistribution Terms][ms-redist].

[ms-wv2]: https://developer.microsoft.com/en-us/microsoft-edge/webview2/
[ms-redist]: https://developer.microsoft.com/en-us/microsoft-edge/webview2/
