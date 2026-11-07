# Morphix Remote

Morphix Remote is the phone UI for the existing Morphix process. The Vercel deployment contains only the React UI. Gemini, Meshy, models, SQLite, slicing, QD330 control, camera access, and AI Print Guardian remain on the Raspberry Pi.

## Security design

```
phone browser -> Vercel static UI -> HTTPS hostname -> Cloudflare Tunnel (outbound) -> 127.0.0.1:8787 -> Morphix
```

- The Pi and QD330 have no inbound router port and no public IP exposure.
- `cloudflared` creates the outbound tunnel. The API itself listens on loopback only.
- The API accepts only exact origins in `MORPHIX_REMOTE_ORIGINS`; there is no wildcard CORS.
- The Pi displays a one-time QR link. Its embedded secret expires after 24 hours, rotates after every successful pairing, and is rate-limited. Nothing is typed on the phone.
- Device tokens are 256-bit random values. Only their SHA-256 hashes are stored on the Pi.
- Model and camera responses require the paired-device bearer token and are never stored by Vercel.
- Starting a print still requires the existing explicit `PendingAction` approval. Print controls still respect `MORPHIX_PRINT_CONTROLS`, `MORPHIX_GX_VERIFIED`, command verification, and printer acknowledgement.

## 1. Run this branch on the Pi

The normal `main` auto-deployment is intentionally untouched. On the Pi, make a separate checkout or switch the Morphix checkout only when you are ready to run the remote branch:

```bash
cd ~/3D-AI-PRINT
git fetch origin
git switch morphix-remote
git pull --ff-only origin morphix-remote
npm ci
npm test
npm run build
```

Add this to `~/Morphix/config/morphix.env`:

```ini
MORPHIX_REMOTE=1
MORPHIX_REMOTE_HOST=127.0.0.1
MORPHIX_REMOTE_PORT=8787
MORPHIX_REMOTE_ORIGINS=https://YOUR-VERCEL-PROJECT.vercel.app
MORPHIX_REMOTE_SITE_URL=https://YOUR-VERCEL-PROJECT.vercel.app
```

Keep the existing Gemini, Meshy, printer, slicer, and Guardian variables unchanged. Restart:

```bash
systemctl --user restart morphix
journalctl --user -u morphix -n 100 --no-pager
curl http://127.0.0.1:8787/api/health
```

The health response should say `{"ok":true,"service":"Morphix Remote"}`.

## 2. Create the outbound Cloudflare Tunnel

A Cloudflare account and a domain using Cloudflare DNS are required for a public HTTPS hostname. In the Cloudflare dashboard:

1. Open **Networking -> Tunnels**, select **Create Tunnel**, choose `cloudflared`, and name it `morphix-remote`.
2. Choose the Pi's Linux architecture and run the installation command shown by Cloudflare. For a remotely managed tunnel it has the form:

   ```bash
   sudo cloudflared service install YOUR_TUNNEL_TOKEN
   ```

3. Add a **Published application** with a hostname such as `morphix-api.example.com`.
4. Set **Service type** to `HTTP` and **URL** to `127.0.0.1:8787`.
5. Save it and confirm the tunnel is Healthy. Do not add a router port-forward.

Verify from another network:

```bash
curl https://morphix-api.example.com/api/health
```

Only `/api/health` and pairing are usable without a device token. The tunnel token is a secret; do not put it in Git or the Morphix env file.

## 3. Deploy the phone UI from `morphix-remote`

1. In Vercel choose **Add New -> Project**, import `isaiahboffill2010-hue/3D-AI-PRINT`, and select the `morphix-remote` branch for the production deployment.
2. Leave **Root Directory** at the repository root. Vercel projects cannot read above a configured subdirectory; the root-level `vercel.json` already builds only `apps/remote`.
3. The detected settings should be:
   - Framework: Vite
   - Install: `npm ci`
   - Build: `npm run build:remote`
   - Output: `apps/remote/dist`
4. Add a Production environment variable:

   ```text
   VITE_MORPHIX_REMOTE_URL=https://3daimodel-morphix.taila52865.ts.net
   ```

5. Deploy. If Vercel first deploys `main`, open **Deployments -> Create Deployment** and enter the `morphix-remote` Git reference, then promote that deployment to Production.
6. Copy the final production origin exactly (no trailing slash) into `MORPHIX_REMOTE_ORIGINS` on the Pi and restart Morphix. If Vercel assigns a different production hostname, update this value before pairing.

## 4. Pair the phone

On the Pi touchscreen, open **Settings -> Morphix Remote**. Scan the displayed QR with the phone camera. The Vercel app opens, exchanges the one-time link for a private device key, removes the secret from the address bar, and connects automatically. There is no account, password, or code entry.

The QR rotates immediately after a successful pairing. Refresh Settings to show the QR for another phone. To revoke the current phone, choose **Device** in the app; to revoke every phone, stop Morphix, remove only `~/Morphix/remote/devices.json`, and restart Morphix.

## Safe acceptance check

1. Leave `MORPHIX_PRINT_CONTROLS` unchanged while testing.
2. Pair the phone and confirm Pi/printer status loads.
3. Send a Gemini chat message that does not request generation.
4. Upload a photo and check that the Meshy credit approval appears before generation begins.
5. Approve generation, preview the GLB/STL, set a size, and prepare it.
6. Confirm that the final print action waits for a separate explicit approval.
7. Test Pause/Resume/Stop only during a supervised test print and only if those controls were already verified under `docs/PHASE5.md`.

Automated tests never confirm a print, call Meshy, or contact the QD330.
