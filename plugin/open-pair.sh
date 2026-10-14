#!/bin/sh
# Opens the pairing QR code as a herdr pane (falls back to printing it).
"${HERDR_BIN_PATH:-herdr}" plugin pane open --plugin hollr --entrypoint pair --placement zoomed 2>/dev/null \
  || exec "$HOME/.local/bin/hollr" pair
