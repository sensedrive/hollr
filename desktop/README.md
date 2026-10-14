# Hollr Desktop (macOS, Linux)

Desktop client for Hollr, built with Tauri (Rust + Svelte). Same security model as the iPhone app:
its own Ed25519 device key, the server's host key pinned at pairing, and only `hollr gate` on the server
(plus TCP connections to the server's own `localhost` for the in-app browser).

Same features as the native app:

- **Sessions** of all servers in the sidebar; omp chats in the TUI style, Claude/Codex/terminals as screens.
  New sessions with model and thinking/effort, model switch in running sessions.
- **Dashboard** across servers, **spaces** (herdr workspaces by repo and worktree), **git** (changes, diffs, history, branches).
- **Live voice** with `omp /live` – microphone and speaker on this computer, streamed over SSH.
- **Server info and tools** (load, processes, setup checks, install/update), **themes**, **notifications**.
- **Localhost browser**: pages that only run on the server (`localhost:3000` …) through the SSH connection
  (`tunnel_open` binds a port on this computer's `127.0.0.1` and forwards each connection via direct-tcpip).

Pair: run `hollr pair --link` on the server and paste the link.

On macOS the app is called **Hollr Desktop** (`app.hollr.desktop`, `src-tauri/tauri.macos.conf.json`) so it can sit next to
the native Mac Catalyst app **Hollr**; on Linux it is **Hollr**.

```bash
cd desktop && bun install
bun run tauri dev                                              # develop
bun run tauri build                                            # Linux: deb, rpm, AppImage
bun run tauri build --bundles dmg --target aarch64-apple-darwin  # macOS DMG (ad-hoc signed)
```

Releases: `.github/workflows/desktop.yml` builds on every `v*` tag and attaches to the release:
Linux `Hollr-<version>-linux-<x64|arm64>.<deb|rpm|AppImage>` and macOS
`Hollr-Desktop-<version>-mac-<apple-silicon|intel>.dmg` (macOS 12+, ad-hoc signed, not notarized).

### Testing the UI in a browser

The backend commands are also available over a small local HTTP bridge, so the UI can be driven in any browser
(handy for automated UI tests; tunnels and live voice need the real app):

```bash
cargo run --manifest-path src-tauri/Cargo.toml --example bridge -- "<app data dir>"   # 127.0.0.1:7419
bun run dev                                                                           # then open http://localhost:1420/?bridge=7419
```
