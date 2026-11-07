# Morphix

AI-powered, voice-controlled 3D printing on a Raspberry Pi 4 + Afinia QD330.
Speak → Gemini understands → Meshy generates → preview → choose size → approve → print → AI monitors.

**Status:** all five phases built and wired: Gemini Live voice, Meshy models, AI-advised local slicing
(PrusaSlicer on the Pi), the AI Print Guardian, printer control (locked until validated), a kid-friendly
touchscreen with light/dark mode, one progress bar for every job, `MX-…` error codes
([docs/ERRORS.md](docs/ERRORS.md)), and an Auth0 web portal where you can send photos, drawings or a
LiDAR scan of a broken part and get a printable copy ([docs/PORTAL.md](docs/PORTAL.md),
[docs/PHOTO3D.md](docs/PHOTO3D.md)). See [docs/PHASES.md](docs/PHASES.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### One-time setup on the Pi
```
sudo apt install -y prusa-slicer openscad      # local slicing + exact-size replacement parts
nano ~/Morphix/config/morphix.env              # keys + Auth0 (see config/morphix.env.example)
systemctl --user restart morphix
```
Portal: `http://192.168.86.38:8443` (same Wi-Fi).

Remote phone access through a Vercel UI and outbound-only tunnel is documented in
[`docs/REMOTE.md`](docs/REMOTE.md). It uses phone pairing instead of accounts and keeps all models on the Pi.

## Repository
```
apps/desktop/           Electron main + preload, React touchscreen UI (1024×600)
packages/shared         IPC contract and shared types
packages/domain         workflow state machine (approval and validation gates)
packages/database       SQLite schema + persistence (sql.js, no native build)
packages/storage        ~/Morphix layout, safe paths, atomic writes, logs
packages/printer        QD330 observer (read-only command allowlist)
packages/meshy          model generators (demo; Meshy in Phase 2)
packages/gemini         assistants (demo; Gemini Live in Phase 2)
packages/slicing        repair, orient, slice (PrusaSlicer/Orca), .gx, AI slicing advisor
packages/photo3d        photos/drawings/scans → model (Gemini vision, Meshy image-to-3D, OpenSCAD)
packages/portal         Auth0 web portal hosted by the Pi (port 8443)
packages/jobs           one progress model for every pipeline
packages/errors         MX-… error codes with kid-friendly titles and hints
packages/guardian       AI Print Guardian (with services/vision)
services/qd330-dashboard  Python web dashboard + CLI for the printer (port 8000)
services/vision         Phase 4 vision worker (planned)
config/                 printer profile, slicer profiles, env example
scripts/pi/             Pi build, launch and service install scripts
tests/                  vitest suites
```

## On the Pi
Pushing to `main` deploys automatically: Pi Manager pulls within a minute and runs `deploy.sh`, which
installs Node 22 for `jd` if needed, installs dependencies when the lockfile changes, runs the tests,
builds, and restarts Morphix if it is running. No sudo required.

```
systemctl --user start morphix      # open Morphix on the touchscreen
systemctl --user stop morphix
journalctl --user -u morphix -f     # app output
ls ~/Morphix                        # models, previews, database, logs, ...
```
API keys: copy `config/morphix.env.example` to `~/Morphix/config/morphix.env` and fill in values.

### QD330 dashboard
`http://192.168.86.38:8000` — status, camera, files, job control (runs as the `qd330-web` user service).
CLI: `qd330ctl status`. This dashboard predates Morphix and includes manual controls (home, temperatures,
G-code console); Morphix itself only observes the printer until Phase 5.
Set `QD330_TOKEN=...` in `~/.config/qd330-web.env` to require a token.

## Development
```
npm install
npm test
npm run build
MORPHIX_WINDOWED=1 MORPHIX_ROOT=/tmp/morphix npm start
```
`MORPHIX_SMOKE=1` runs a headless end-to-end check (prompt → demo model → stored → served) and exits.

## Safety rules
Never start a physical print without explicit approval · never claim a pause/stop without printer
confirmation · no unverified printer commands from Morphix · the printer and its unauthenticated camera
stay on the private Ethernet link · no keys in git.
