#!/bin/bash
# One-time install of the dashboard service. Run on the Pi: sudo bash setup/install.sh
set -euo pipefail
cd "$(dirname "$0")"
install -m 644 qd330-web.service /etc/systemd/system/qd330-web.service
# Optional settings (printer IP, port, access token) live outside git:
[ -f /etc/qd330-web.env ] || printf '# QD330_HOST=192.168.10.51\n# QD330_WEB_PORT=8000\n# QD330_TOKEN=choose-a-secret\n' > /etc/qd330-web.env
cat > /usr/local/bin/qd330ctl <<'SH'
#!/bin/bash
cd /home/jd/pi-manager && exec python3 -m printer_control.cli "$@"
SH
chmod 755 /usr/local/bin/qd330ctl
systemctl daemon-reload
systemctl enable --now qd330-web.service
sleep 2
systemctl --no-pager --lines=3 status qd330-web.service || true
echo "Dashboard: http://$(hostname -I | awk '{print $1}'):8000"
