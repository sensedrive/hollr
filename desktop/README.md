# Hollr Desktop (Linux, Windows, macOS)

Desktop client for Hollr, built with Tauri (Rust + Svelte). Same security model as the iPhone app:
its own Ed25519 device key, the server's host key pinned at pairing, and only `hollr gate` on the server.

- Pair: run `hollr pair --link` on the server and paste the link.
- Sessions of all servers on the left; omp chats in the TUI style, Claude/Codex/terminals as screens.
- New sessions with model and thinking/effort, model switch in running sessions.

```bash
cd desktop && bun install
bun run tauri dev          # develop
bun run tauri build        # packages (Linux: deb, rpm, AppImage)
```

Releases: `.github/workflows/desktop.yml` builds Linux x64 and arm64 packages on every `v*` tag and attaches them.
