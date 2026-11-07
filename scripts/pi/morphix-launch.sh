#!/bin/bash
# Starts Morphix fullscreen on the Pi touchscreen (Wayland/labwc session).
set -euo pipefail
cd "$(dirname "$0")/../.."
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
exec ./node_modules/electron/dist/electron . "$@"
