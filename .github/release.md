## Install

### 1 · Server – the machine your agents run on

```bash
curl -fsSL https://raw.githubusercontent.com/sensedrive/hollr/main/install.sh | bash
hollr pair          # QR code for the iPhone
hollr pair --link   # pairing link for the Mac and Linux apps
```

Linux x64/arm64 and macOS (Apple Silicon). On a Mac, turn on *System Settings → General → Sharing → Remote Login* first.
The `hollr-linux-*` / `hollr-darwin-*` files below are the server binaries the installer downloads – you don't need them by hand.

### 2 · App

Two apps, same features: **Hollr** is the native app (SwiftUI) for iPhone and Mac,
**Hollr Desktop** is the Tauri app for Mac and Linux. On a Mac, pick either one – they can be installed side by side.

| | Download | |
|---|---|---|
| **Hollr** · Mac, Apple Silicon | [Hollr-${V}-mac-apple-silicon.dmg](${URL}/Hollr-${V}-mac-apple-silicon.dmg) | native, M1 and newer |
| **Hollr** · Mac, Intel | [Hollr-${V}-mac-intel.dmg](${URL}/Hollr-${V}-mac-intel.dmg) | native |
| **Hollr** · iPhone | build from [`ios/`](https://github.com/sensedrive/hollr/tree/main/ios) | |
| **Hollr Desktop** · Mac, Apple Silicon | [Hollr-Desktop-${V}-mac-apple-silicon.dmg](${URL}/Hollr-Desktop-${V}-mac-apple-silicon.dmg) | macOS 12+ |
| **Hollr Desktop** · Mac, Intel | [Hollr-Desktop-${V}-mac-intel.dmg](${URL}/Hollr-Desktop-${V}-mac-intel.dmg) | macOS 12+ |
| **Hollr Desktop** · Debian, Ubuntu | [x64 .deb](${URL}/Hollr-${V}-linux-x64.deb) · [arm64 .deb](${URL}/Hollr-${V}-linux-arm64.deb) | `sudo apt install ./Hollr-*.deb` |
| **Hollr Desktop** · Fedora, openSUSE | [x64 .rpm](${URL}/Hollr-${V}-linux-x64.rpm) · [arm64 .rpm](${URL}/Hollr-${V}-linux-arm64.rpm) | `sudo dnf install ./Hollr-*.rpm` |
| **Hollr Desktop** · any Linux | [x64 AppImage](${URL}/Hollr-${V}-linux-x64.AppImage) · [arm64 AppImage](${URL}/Hollr-${V}-linux-arm64.AppImage) | `chmod +x Hollr-*.AppImage` and run it |

Then in the app: **Pair server** → paste the link from `hollr pair --link` (iPhone: scan the QR code).

**Mac:** The DMGs are not notarized yet. Drag *Hollr* or *Hollr Desktop* to *Applications*, open it once, then allow it under
*System Settings → Privacy & Security → Open Anyway*. Or run:
`xattr -dr com.apple.quarantine /Applications/Hollr.app` (or `"/Applications/Hollr Desktop.app"`)
