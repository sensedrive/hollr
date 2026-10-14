#!/usr/bin/env bash
# Hollr server installer – talk to omp /live on this server from your iPhone.
#
#   curl -fsSL https://raw.githubusercontent.com/sensedrive/hollr/main/install.sh | bash
#
# Installs what is missing and leaves everything else alone:
#   PulseAudio (virtual mic/speaker) · herdr · omp · hollr binary · herdr plugin
# Re-run any time to update. Options (env): HOLLR_VERSION=v0.1.0  HOLLR_SKIP_DEPS=1  HOLLR_REPO=owner/repo
set -euo pipefail

REPO="${HOLLR_REPO:-sensedrive/hollr}"
VERSION="${HOLLR_VERSION:-latest}"
BIN_DIR="$HOME/.local/bin"
SHARE_DIR="$HOME/.local/share/hollr"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
die() { printf '\n\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1 || [ -x "$BIN_DIR/$1" ]; }
# macOS: (re)start a launchd agent – restart if registered (picks up a new binary), else register it
launchd_up() {
  if launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$1" >/dev/null 2>&1 || true
  else
    launchctl bootstrap "gui/$(id -u)" "$2" >/dev/null 2>&1 || { sleep 1; launchctl bootstrap "gui/$(id -u)" "$2" >/dev/null 2>&1; } || true
  fi
  sleep 1
}

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if has sudo; then SUDO="sudo"; else SUDO=""; fi
fi

ORIG_PATH="$PATH"
mkdir -p "$BIN_DIR" "$SHARE_DIR"
export PATH="$BIN_DIR:$PATH"

# ---------------------------------------------------------------- platform
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64) TARGET="linux-x64" ;;
  Linux-aarch64 | Linux-arm64) TARGET="linux-arm64" ;;
  Darwin-arm64) TARGET="darwin-arm64" ;;
  *) die "Nicht unterstützt: $OS/$ARCH (Linux x64/arm64 oder macOS arm64)" ;;
esac
bold "Hollr-Installation auf $(hostname) ($TARGET)"

# ---------------------------------------------------------------- audio
install_pkgs() {
  if has apt-get; then $SUDO apt-get update -qq && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  elif has dnf; then $SUDO dnf install -y -q "$@"
  elif has yum; then $SUDO yum install -y -q "$@"
  elif has pacman; then $SUDO pacman -S --noconfirm --needed "$@"
  elif has zypper; then $SUDO zypper --non-interactive install "$@"
  elif has apk; then $SUDO apk add --no-cache "$@"
  else die "Bitte manuell installieren: $*"; fi
}

if [ "$OS" = "Linux" ] && [ -z "${HOLLR_SKIP_DEPS:-}" ]; then
  bold "1/5 Audio (PulseAudio)"
  if has pactl && has pacat; then ok "pactl/pacat vorhanden"
  else
    info "installiere pulseaudio + pulseaudio-utils"
    if has pacman || has apk; then install_pkgs pulseaudio pulseaudio-utils 2>/dev/null || install_pkgs pulseaudio
    elif has zypper; then install_pkgs pulseaudio pulseaudio-utils
    else install_pkgs pulseaudio pulseaudio-utils; fi
    ok "PulseAudio installiert"
  fi
  # PipeWire systems ship a pulse-compatible server; otherwise run pulseaudio as user service
  if ! pactl info >/dev/null 2>&1; then
    systemctl --user enable --now pulseaudio.socket pulseaudio.service >/dev/null 2>&1 \
      || pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 || true
  fi
  pactl info >/dev/null 2>&1 && ok "Audio-Server läuft" || info "Audio-Server startet nicht – siehe 'hollr doctor'"
  # keep user services (pulseaudio) running without an open login session
  if has loginctl && ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q yes; then
    $SUDO loginctl enable-linger "$USER" && ok "linger aktiviert (Audio läuft auch ohne Login)" || info "linger nicht aktivierbar"
  fi
fi

if [ "$OS" = "Darwin" ] && [ -z "${HOLLR_SKIP_DEPS:-}" ]; then
  bold "1/5 Audio (Live-Sprache)"
  # live calls: omp uses the Mac's default devices, Hollr points them at BlackHole during a call
  if has brew; then
    for f in sox switchaudio-osx; do brew list "$f" >/dev/null 2>&1 || brew install -q "$f" >/dev/null 2>&1 || true; done
  fi
  if [ -d "/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver" ] && [ -d "/Library/Audio/Plug-Ins/HAL/BlackHole16ch.driver" ]; then
    ok "Live-Audio: BlackHole vorhanden"
  else
    info "Für Live-Sprache einmalig (fragt nach dem Mac-Passwort): brew install --cask blackhole-2ch blackhole-16ch"
  fi
fi

# ---------------------------------------------------------------- herdr + omp
if [ -z "${HOLLR_SKIP_DEPS:-}" ]; then
  bold "2/5 herdr"
  if has herdr; then ok "herdr $(herdr --version 2>/dev/null | head -1)"
  else curl -fsSL https://herdr.dev/install.sh | sh; ok "herdr installiert"; fi

  bold "3/5 omp (Oh My Pi)"
  if has omp; then ok "$(omp --version 2>/dev/null | head -1)"
  else curl -fsSL https://omp.sh/install | sh -s -- --binary; ok "omp installiert"; fi
fi

# ---------------------------------------------------------------- hollr binary
bold "4/5 hollr"
# a binary next to the script only when it runs from a checkout (not when piped from curl)
SRC_DIR=""
[ -f "${BASH_SOURCE[0]:-}" ] && SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSET="hollr-$TARGET"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/server/dist/$ASSET" ]; then
  cp "$SRC_DIR/server/dist/$ASSET" "$TMP/hollr"; info "aus lokalem Checkout"
else
  URL="https://github.com/$REPO/releases/latest/download/$ASSET"
  [ "$VERSION" != "latest" ] && URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
  if ! curl -fsSL "$URL" -o "$TMP/hollr"; then
    # forks kept private: fall back to the GitHub CLI
    has gh || die "Download fehlgeschlagen ($URL)."
    if [ "$VERSION" = "latest" ]; then gh release download -R "$REPO" -p "$ASSET" -D "$TMP" --clobber
    else gh release download "$VERSION" -R "$REPO" -p "$ASSET" -D "$TMP" --clobber; fi
    mv "$TMP/$ASSET" "$TMP/hollr"
  fi
fi
chmod +x "$TMP/hollr"
NEW_V="$("$TMP/hollr" version 2>/dev/null || echo 0)"
OLD_V="$([ -x "$BIN_DIR/hollr" ] && "$BIN_DIR/hollr" version 2>/dev/null || echo 0)"
# never downgrade by accident (HOLLR_FORCE=1 to allow)
if [ "$OLD_V" != "0" ] && [ -z "${HOLLR_FORCE:-}" ] && [ "$(printf '%s\n%s\n' "$NEW_V" "$OLD_V" | sort -V | tail -1)" != "$NEW_V" ]; then
  ok "hollr $OLD_V ist neuer als $NEW_V – bleibt installiert"
else
  # atomic swap – works while phones are connected (running binary stays valid)
  install -m 755 "$TMP/hollr" "$BIN_DIR/.hollr.new" && mv -f "$BIN_DIR/.hollr.new" "$BIN_DIR/hollr"
  ok "hollr $("$BIN_DIR/hollr" version) → $BIN_DIR/hollr"
fi

# ---------------------------------------------------------------- herdr plugin
bold "5/5 herdr-Plugin"
PLUGIN_DIR="$SHARE_DIR/plugin"
mkdir -p "$PLUGIN_DIR"
if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/plugin/herdr-plugin.toml" ]; then
  cp -R "$SRC_DIR/plugin/." "$PLUGIN_DIR/"
else
  for f in herdr-plugin.toml open-pair.sh; do
    curl -fsSL "https://raw.githubusercontent.com/$REPO/main/plugin/$f" -o "$PLUGIN_DIR/$f" \
      || gh api "repos/$REPO/contents/plugin/$f" -H "Accept: application/vnd.github.raw" > "$PLUGIN_DIR/$f"
  done
fi
chmod +x "$PLUGIN_DIR/open-pair.sh"
if has herdr; then
  herdr plugin link "$PLUGIN_DIR" >/dev/null 2>&1 && ok "Plugin verknüpft (herdr-Menü: 'Hollr: iPhone koppeln')" \
    || info "herdr-Server läuft nicht – Plugin später: herdr plugin link $PLUGIN_DIR"
fi

# ---------------------------------------------------------------- watcher (push)
if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/hollr-watch.service" <<UNIT
[Unit]
Description=Hollr watcher (push notifications for agent activity)
After=default.target

[Service]
ExecStart=$BIN_DIR/hollr watch
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user enable hollr-watch.service >/dev/null 2>&1 || true
  # restart so an updated binary is used
  systemctl --user restart hollr-watch.service >/dev/null 2>&1 \
    && ok "Wächter läuft (Push: hollr push setup …)" || info "Wächter nicht startbar – siehe 'systemctl --user status hollr-watch'"
fi

if [ "$OS" = "Darwin" ]; then
  AGENT="$HOME/Library/LaunchAgents/app.hollr.watch.plist"
  mkdir -p "$(dirname "$AGENT")"
  cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.hollr.watch</string>
  <key>ProgramArguments</key><array><string>$BIN_DIR/hollr</string><string>watch</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$BIN_DIR:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/hollr-watch.log</string>
</dict></plist>
PLIST
  launchd_up "app.hollr.watch" "$AGENT"
  launchctl list app.hollr.watch 2>/dev/null | grep -q '"PID"' \
    && ok "Wächter läuft (launchd)" || info "Wächter nicht startbar – launchctl print gui/$(id -u)/app.hollr.watch"
fi

# ---------------------------------------------------------------- done
echo
"$BIN_DIR/hollr" doctor || true
cat <<EOF

$(bold "Fertig. Noch zwei Schritte:")
  1. omp einmal mit deinem ChatGPT-Konto anmelden (für /live):
       omp          →  /login  →  OpenAI Codex (ChatGPT)
  2. iPhone koppeln (QR-Code mit der Kamera oder in Hollr scannen):
       hollr pair

  Team: jede Person koppelt ihr eigenes iPhone mit 'hollr pair'.
        Übersicht: hollr devices   ·   Entfernen: hollr revoke <name>
EOF
case ":$ORIG_PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "  Hinweis: ~/.local/bin zum PATH hinzufügen." ;; esac
