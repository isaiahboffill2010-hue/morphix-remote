#!/bin/bash
# Run by Pi Manager (as jd) after every push to main.
set -euo pipefail
cd "$(dirname "$0")"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

echo "== QD330 dashboard"
python3 -m py_compile services/qd330-dashboard/printer_control/*.py
bash scripts/pi/install-user-services.sh

echo "== Morphix"
bash scripts/pi/build-morphix.sh
if systemctl --user is-active --quiet morphix.service; then
  systemctl --user restart morphix.service
  echo "Morphix restarted with the new build"
else
  echo "Morphix built. Start it with: systemctl --user start morphix"
fi
