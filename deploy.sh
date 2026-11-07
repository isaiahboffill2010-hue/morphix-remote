#!/bin/bash
# Run by Pi Manager (as jd) after every push to main.
set -euo pipefail
cd "$(dirname "$0")"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

echo "== QD330 dashboard"
python3 -m py_compile services/qd330-dashboard/printer_control/*.py
bash scripts/pi/install-user-services.sh

echo "== Fonts"
bash scripts/pi/ensure-fonts.sh || echo "WARNING: could not install the emoji font"

echo "== Guardian (Python/OpenCV)"
bash scripts/pi/ensure-vision.sh || echo "WARNING: guardian Python setup failed; monitoring will report the worker as down"

echo "== Morphix"
bash scripts/pi/build-morphix.sh
systemctl --user restart morphix.service
sleep 8
if systemctl --user is-active --quiet morphix.service; then
  echo "Morphix restarted with the new build"
else
  echo "WARNING: Morphix did not stay running; see: journalctl --user -u morphix -n 50"
  exit 1
fi
