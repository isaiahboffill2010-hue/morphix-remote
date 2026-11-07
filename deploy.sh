#!/bin/bash
# Run by Pi Manager (as user jd) after every push to main.
set -euo pipefail
cd "$(dirname "$0")"
python3 -m py_compile printer_control/*.py
if systemctl is-enabled --quiet qd330-web.service 2>/dev/null; then
  # The web service restarts itself when its code changes; nothing else to do.
  echo "qd330-web will reload the new code within a few seconds"
else
  echo "qd330-web not installed yet. Run once on the Pi: sudo bash $(pwd)/setup/install.sh"
fi
