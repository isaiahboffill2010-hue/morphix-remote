# 3D-AI-PRINT — QD330 control system

Control system for an **Afinia 3D QD330** printer connected to a Raspberry Pi over Ethernet.
Pushing to `main` deploys to the Pi automatically (Pi Manager pulls every minute and runs `deploy.sh`).

## Network layout
| Device | Address |
|---|---|
| Pi (`eth0`) | 192.168.10.1 |
| QD330 printer | 192.168.10.51 (control: TCP 8899, camera: 8080) |
| Dashboard | `http://<pi-wifi-ip>:8000` |

## Web dashboard
Live status (temps, progress, layer, position), camera stream and snapshot, home, pause / resume / cancel,
nozzle and bed temperatures, fan, light, motors off, files stored on the printer (print any of them),
upload `.gx` / `.g` files (optionally start printing), a raw G-code console, and a dance button.

## Command line (on the Pi)
```
qd330ctl status            qd330ctl files            qd330ctl home
qd330ctl nozzle 210        qd330ctl bed 60           qd330ctl cooldown
qd330ctl fan on|off        qd330ctl led on|off       qd330ctl motors-off
qd330ctl pause|resume|cancel
qd330ctl print "leaf_coaster (1).gx"
qd330ctl upload part.gx --start
qd330ctl snapshot cam.jpg
qd330ctl gcode M115 M119
```

## Python
```python
from printer_control import QD330
p = QD330()            # 192.168.10.51
p.status(); p.home(); p.upload("part.gx", open("part.gx", "rb").read(), start=True)
```

## Setup (once, on the Pi)
```
sudo bash /home/jd/pi-manager/setup/install.sh
```
Installs the `qd330-web` service and the `qd330ctl` command. Afterwards each push reloads the
dashboard automatically (the service restarts itself when its code changes).

Optional settings go in `/etc/qd330-web.env` (kept out of git): `QD330_HOST`, `QD330_WEB_PORT`,
and `QD330_TOKEN` — set a token to require `?token=...` on the dashboard, since anyone on the
Wi-Fi network can otherwise reach it.

## Notes
- The printer ignores direct movement commands (G1) over the network; motion only happens
  through G28 (home) or a print job — that is how the dance works.
- Plain `.g` jobs can stall at 0%; slicer-made `.gx` files are the reliable format.
