# Phase 5 — QD330 printer control

**Status:** built and tested against a fake printer only. **Not validated on the real QD330.**
Control stays **disabled** until every step of the [operator checklist](#operator-validation-checklist) has passed with the user present.

Everything lives in `packages/printer/src` and is exported from `@morphix/printer`:

| File | What it holds |
|---|---|
| `index.ts` | Phase 1 observer (`TcpTransport`, `PrinterObserver`, …), unchanged behaviour; re-exports everything below |
| `protocol.ts` | Wire format: command framing, reply parsing, upload packets, CRC-32, M661 list parser. Pure functions |
| `names.ts` | `sanitizeFileName` (uploads), `assertStoredFileName` (files already on the printer) |
| `auth.ts` | `authorizePrint`, `PrintAuthorizer`, `PrintAuthorization` tokens |
| `control.ts` | `QD330Controller` (listFiles, uploadFile, startPrint, pause, resume, cancel) |
| `tracker.ts` | `JobTracker` (progress, completion/failure events), `detectActivePrint` (restart recovery) |
| `fake-server.ts` | `FakeQD330`, a fake printer on 127.0.0.1 for tests and demos |

Tests: `tests/phase5-*.test.ts`. They only ever connect to 127.0.0.1; `tests/phase5-helpers.ts` patches `Socket.connect` so any other host fails the test.

---

## Safety model

1. **Disabled by default.** `new QD330Controller({ enabled, host })` requires an explicit boolean. With `enabled: false`, every control method (`listFiles`, `uploadFile`, `startPrint`, `pause`, `resume`, `cancel`) throws `ControllerDisabledError` before opening a socket, and a `rejected` log entry is written. There is no setter: turning control on means constructing a new controller.
2. **Separate from observation.** The Phase 1 observer and its read-only allowlist are unchanged. `controller.transport` is a read-only transport (same allowlist) that shares the controller's queue, so status polls and control sessions never overlap. It works while control is disabled.
3. **Approval tokens.** Anything that starts or changes a print needs a `PrintAuthorization` from `authorizePrint({ jobId, fileName, approvedBy: "touch" | "voice", expiresInMs })`:
   - only tokens issued by this process are accepted (looked up by a random id; a copied or edited token is `unknown`/`tampered`);
   - bound to one `jobId` **and** one `fileName`; mismatches are rejected;
   - short-lived: default 2 min, hard cap 10 min;
   - `startPrint` and `resume` **consume** the token (single use). The token is consumed right before the command is sent, so a busy printer or a missing file does not burn the approval;
   - `uploadFile` checks the token but does not consume it, so one approval covers "upload this file, then start it".
   - Rejections throw `PrintAuthorizationError` with `code`: `missing | unknown | tampered | expired | reused | job-mismatch | file-mismatch`. Nothing is sent.
4. **Pause and cancel need no token** (stopping must always be possible) but take `{ requestedBy: "touch" | "voice" | "guardian" | "system", reason? }` and are always logged.
5. **Confirmed, not assumed.** Every result is `{ sent, acknowledged, confirmed, status, error }`. Only `confirmed` means done, and it is set only when the printer's own status (M119/M27, polled until a timeout) shows the expected change. A `Received … ok` reply without the status change is reported as `acknowledged: true, confirmed: false` with an error.
6. **Preconditions before sending.** Upload only when `READY` and (unless `overwrite`) the name is not already stored. Start only when `READY` and the file is in the M661 list. Pause only when `BUILDING_FROM_SD`. Resume only from a paused status, and only for the paused file. Cancel is always sent.
7. **File names.** Uploads are sanitised to `[A-Za-z0-9._-]`, ≤ 64 chars, `.gx` only (`.g` only with `allowPlainGcode: true`; plain `.g` stalled at 0% on the real printer). Files already on the printer (e.g. official Afinia files with spaces) are passed through `assertStoredFileName`, which rejects `/ \ ~`, control characters and leading dots, so nothing can inject a second command.
8. **No direct G-code.** The controller has no method that sends arbitrary commands; commands are built only from the verbs listed below.
9. **One thing at a time.** All control and status traffic goes through one queue; every session is `M601 S1 … M602`.

---

## API

### `QD330Controller`

```ts
const controller = new QD330Controller({
  enabled: false,              // required, explicit
  host: "192.168.10.51",
  port: 8899,
  // optional (defaults):
  connectTimeoutMs: 4000,
  replyTimeoutMs: 5000,
  startReplyTimeoutMs: 10_000, // M23 reply
  uploadFinishTimeoutMs: 15_000, // M29 reply
  startConfirmTimeoutMs: 20_000, // wait for BUILDING_FROM_SD after M23
  confirmTimeoutMs: 10_000,    // wait for the expected status after M25/M24/M26
  pollIntervalMs: 1000,
  packetDelayMs: 50,           // between upload packets
  maxUploadBytes: 64 MiB,
  allowPlainGcode: false,
  pausedStatuses: ["PAUSED"],  // UNVERIFIED — set from checklist step 6
  authorizer: defaultPrintAuthorizer,
  log: (entry: ControlLogEntry) => void,
});
```

| Method | Command(s) | Token | Confirmed when | Hardware-verified |
|---|---|---|---|---|
| `readStatus()` | M119 M105 M114 M27 | — | (read-only, allowed while disabled) | yes |
| `listFiles()` | M661 | — | binary list parsed | yes |
| `uploadFile(name, data, { jobId, authorization, onProgress?, overwrite? })` | M28, packets, M29 | checked, not consumed | file appears in M661 | single packet only |
| `startPrint({ jobId, fileName, authorization })` | M23 `0:/user/<name>` | consumed | `MachineStatus: BUILDING_FROM_SD` and `CurrentFile` matches | yes (status change); a real `.gx` print: **no** |
| `pause({ requestedBy, reason? })` | M25 | none, logged | `MachineStatus` ∈ `pausedStatuses` | **no** |
| `resume({ jobId, fileName, authorization })` | M24 | consumed | `MachineStatus: BUILDING_FROM_SD` | **no** |
| `cancel({ requestedBy, reason? })` | M26 | none, logged | `MachineStatus: READY` | yes |

`ControlResult<T>`:

```ts
{
  op: "listFiles" | "upload" | "start" | "pause" | "resume" | "cancel";
  sent: boolean;          // the control command reached the socket
  acknowledged: boolean;  // "CMD <X> Received." … "ok", no error text
  confirmed: boolean;     // printer status shows the change — the only "done"
  protocolVerified: boolean; // false for M24/M25
  status?: PrinterStatus; // last status read during the operation
  reply?: string; error?: string; data?: T;
}
```

Throws (nothing sent): `ControllerDisabledError`, `PrintAuthorizationError`, `InvalidFileNameError`, `RangeError` (empty/oversized upload). Every other problem (timeout, dropped connection, printer refusing control, wrong status) comes back as a result with `error` set and `confirmed: false`.

`UploadProgress` passed to `onProgress` after each packet: `{ bytesSent, totalBytes, packetsSent, totalPackets, percent }`.

`ControlLogEntry`: `{ at, op, outcome: "rejected" | "failed" | "unconfirmed" | "confirmed", jobId?, fileName?, approvedBy?, requestedBy?, reason?, sent, acknowledged, confirmed, error?, status? }`.

### Approval

```ts
const token = authorizePrint({ jobId, fileName: "Robot_Arm.gx", approvedBy: "touch", expiresInMs: 60_000 });
```

`PrintAuthorizer` (class) exists for tests and custom clocks; `defaultPrintAuthorizer` is the process-wide instance used by `authorizePrint` and by every controller unless one is passed in. `revoke(token)` cancels an approval.

### Job tracking

```ts
const tracker = new JobTracker({ pausedStatuses, completeAtProgress: 99 });
tracker.on("progress", (job) => …);  // also: started, recovered, paused, resumed,
                                      // completed, cancelled, failed, offline, online,
                                      // unknownStatus(job, machineStatus), change
tracker.update(status);               // feed every PrinterObserver status
tracker.track({ jobId, fileName, status }); // after startPrint() is confirmed
tracker.noteCancelRequested();        // before/when cancel() is sent
tracker.attachJob(jobId);             // link a recovered print to a DB job
tracker.job;                          // { jobId, fileName, phase, progress, layer, recovered, offline, … }
detectActivePrint(status, pausedStatuses) // { fileName, paused, progress, layer } | null
```

Rules: `BUILDING_FROM_SD` or a paused status with no tracked job → `recovered` (app restart, or a print started at the printer). Return to `READY` → `cancelled` if a cancel was noted, else `completed` if progress ≥ `completeAtProgress` or the last layer was reached (looking at both the last building status and the READY status), else `failed`. Any other MachineStatus → `unknownStatus`, no outcome guessed. Offline polls keep the job (the SD print carries on) and emit `offline`/`online`. Completion detection is a heuristic until checklist step 4 confirms what M27 shows at the end of a real print.

### Fake printer

```ts
const fake = new FakeQD330({ files: { "cube.gx": buf }, pausedStatus: "PAUSED", stateChangeDelayMs: 0, m661Ok: true,
  failures: { refuseControl, silent: ["M23"], dropOn: ["M26"], corruptPacket: 1, dropOnPacket: 2, rejectUpload,
              loseUploadedFile, ignoreStart, ignorePause, ignoreResume, ignoreCancel } });
const port = await fake.listen();   // always 127.0.0.1
fake.setProgress(45, [45, 100]); fake.finishPrint(); fake.abortPrint();
fake.received;      // every command, in order
fake.uploads;       // upload outcomes
fake.controlConflicts; // M601 attempts refused because another connection held control
await fake.close();
```

Reply formats copied from the real printer: `CMD X Received.` … `ok`, `Control Success V2.1.`, `Control Release.`, M115/M119/M105/M114/M27 bodies, the binary M661 list, `Writing to file: /data/<name>`, `File opened: <name> Size: <n>` / `File selected`. Error wordings (M28/M29/M23 failures, per-packet CRC errors, `Control failed.`) and the paused status string are guesses and are marked `UNVERIFIED` in the source.

---

## What is verified and what is not

| Fact | Status |
|---|---|
| `~CMD\r\n` framing, `CMD X Received.` … `ok` replies | verified |
| M601 S1 / M602 session | verified |
| M115, M119, M105, M114, M27 formats | verified |
| M661 binary list | verified |
| M28 `<size> 0:/user/<name>` → `Writing to file: /data/<name>` | verified |
| Packet framing (16-byte BE header, CRC-32 of unpadded chunk, 4096 padding) | verified with **one** packet; multi-packet uploads unverified |
| Per-packet replies / error reporting during upload | unknown (controller scans any unsolicited text for error words) |
| M29 reply text | unknown (controller requires `Received … ok` without error words) |
| M23 → `BUILDING_FROM_SD`, `CurrentFile` | verified with a plain `.g` (which then stalled at 0%) |
| A real `.gx` printing to completion; M27 values at the end | **unverified** |
| M26 cancel → `READY` | verified |
| M25 pause / M24 resume, and the paused MachineStatus string | **unverified** |
| Whether the printer accepts a second control connection | unknown (controller never opens two) |

---

## Integration steps (apps/desktop — for the coordinator)

1. **Construct once in the main process**, disabled unless the operator turned it on after the checklist:
   ```ts
   const controller = new QD330Controller({
     enabled: settings.printControlsEnabled === true,   // stays false until sign-off
     host: settings.printerHost,
     pausedStatuses: settings.printerPausedStatuses ?? ["PAUSED"],
     log: (e) => logger.info("printer-control", e),     // persist to the logs table
   });
   ```
2. **Route observation through the controller's queue:** replace `new PrinterObserver(new TcpTransport(host), onStatus)` with `new PrinterObserver(controller.transport, onStatus)`. Behaviour is the same (read-only allowlist), but polls can no longer collide with a control session.
3. **Track jobs:** `const tracker = new JobTracker({ pausedStatuses })`; call `tracker.update(status)` in the observer callback; forward tracker events to the renderer over IPC.
4. **On start-up:** after the first poll, `detectActivePrint(observer.status)`. If it returns a print, look up the matching job by file name, `tracker.attachJob(id)`, move the workflow to `printing` (domain `transition` with `printControlsEnabled`), and show "print in progress" instead of the idle screen. Do not start anything.
5. **Approval flow (touch):** the confirm screen shows file, model, estimated time and filament. Only the confirm button handler in the **main process** calls `authorizePrint({ jobId, fileName, approvedBy: "touch", expiresInMs: 60_000 })`. Then `uploadFile` → if `confirmed`, `startPrint` with the same token → if `confirmed`, `tracker.track(...)` and the domain transition to `printing` (`userApproved: true`). Show `error` to the user on any unconfirmed step; never show "printing" unless `startPrint(...).confirmed`.
6. **Approval flow (voice):** Gemini's tool call may only *request* a print. The main process asks the user to confirm ("Say 'yes, print' to start Robot_Arm.gx") and mints the token with `approvedBy: "voice"` only after it hears the confirmation. The model must never be able to call `authorizePrint` directly.
7. **Pause / cancel:** buttons, voice and the Phase 4 guardian call `controller.pause({ requestedBy, reason })` / `controller.cancel(...)`. Call `tracker.noteCancelRequested()` before cancel. Show "pausing…/cancelling…" until the result is `confirmed`; if not confirmed, tell the user to use the printer's own screen.
8. **Resume:** needs a fresh confirmation → new token for the same job and file.
9. **Settings:** keep `printControlsEnabled: false` in shipped config. Turning it on is an operator action after sign-off (below), never something the app or the assistant does.

The domain package already blocks `uploading`/`ready`/`printing` without `printControlsEnabled` and `userApproved`; keep both checks: the domain guard protects the workflow state, the controller guard protects the printer.

---

## Operator validation checklist

Run on the Pi, at the printer, **with the user present and watching the printer**, one command at a time. For each step write down the exact replies (copy from the control log) in `docs/PHASE5-validation.md`. Stop at the first surprise. Keep a hand near the printer's power switch.

Use a throw-away script or the Node REPL with `new QD330Controller({ enabled: true, host: "192.168.10.51", log: console.log })`. This is the only place `enabled: true` is allowed before sign-off; the app's setting stays off.

**0. Preconditions**
- [ ] Bed clear, filament loaded, nozzle clean; printer shows READY on its own screen.
- [ ] The Afinia software's own print of the same file works (known-good printer).
- [ ] `controller.readStatus()` → `machine: "READY"`, sensible temperatures.

**1. List files (M661)**
- [ ] `listFiles()` returns the files the printer's own screen shows. Note the exact name of an **official Afinia `.gx`** already on the printer (e.g. a calibration cube).

**2. Approval gate dry run (no printer traffic expected)**
- [ ] `startPrint` with no token, an expired token, and a token for a different file all throw `PrintAuthorizationError`; the log shows `rejected`; the printer does nothing.

**3. Start the official `.gx` (M23)**
- [ ] `startPrint({ jobId: "val-1", fileName: "<official>.gx", authorization: authorizePrint({ jobId: "val-1", fileName: "<official>.gx", approvedBy: "touch" }) })`.
- [ ] Result `confirmed: true`; the printer heats and starts printing.
- [ ] Record `MachineStatus`, `CurrentFile` (with or without path/extension?), and M27 during heating and printing.

**4. Let it run, watch tracking**
- [ ] Progress and layer advance in the observer/tracker.
- [ ] Either let it finish and record M119/M27 at the end (sets the completion heuristic), or go on to step 5.

**5. Pause (M25) — unverified command**
- [ ] `pause({ requestedBy: "touch", reason: "validation" })`. The head should park/stop.
- [ ] Record the exact `MachineStatus` while paused. If it is not `PAUSED`, the result is `confirmed: false`: this is expected — add the observed value to `pausedStatuses` and repeat.
- [ ] Check what happens to nozzle/bed temperatures during pause.

**6. Resume (M24) — unverified command**
- [ ] `resume({ jobId: "val-1", fileName, authorization: <fresh token> })` → printing continues where it stopped, `confirmed: true`.

**7. Cancel (M26)**
- [ ] `cancel({ requestedBy: "touch", reason: "validation" })` → printer stops, `confirmed: true` (READY). Record what M27 shows afterwards and whether heaters turn off.
- [ ] Remove the partial print.

**8. Upload a known-good `.gx` (M28/M29)**
- [ ] Take a `.gx` produced by the official Afinia/FlashPrint software for this printer (several packets in size, e.g. > 50 KB).
- [ ] `uploadFile("validation_cube.gx", data, { jobId: "val-2", authorization, onProgress: console.log })` → `confirmed: true`; the file shows on the printer's screen.
- [ ] Note any per-packet replies the printer sent (they appear in errors/logs) and how long M29 took. Adjust `packetDelayMs` if needed.
- [ ] Start it with the same token (`startPrint`) → prints correctly from the first layer (proves the upload was byte-exact). Cancel after a few layers.

**9. Upload a Morphix/Phase 3 `.gx`**
- [ ] Same as step 8 with a file from `packages/slicing`; watch the first layer closely. Cancel at the first sign of trouble.

**10. Failure behaviour**
- [ ] Unplug Ethernet during a print: tracker emits `offline`, print continues, `online` on reconnect, no false `failed`.
- [ ] Restart the app mid-print: start-up shows the print as recovered; nothing is re-sent.
- [ ] Cancel from the printer's own screen: tracker reports `failed` (unexplained stop) — not `completed`.

### Before `enabled` may be turned on in the app

All of the following must be true and written down:

- [ ] Steps 0–10 passed with the user present; replies recorded in `docs/PHASE5-validation.md`.
- [ ] `pausedStatuses` set to the value observed in step 5 (or pause disabled in the UI if M25 did not work).
- [ ] Completion detection checked against a real finished print (step 4); `completeAtProgress` adjusted if needed.
- [ ] Multi-packet upload proven byte-exact (step 8 printed correctly).
- [ ] The app's approval screens (touch and voice) mint tokens only in the main process after an explicit user action, and show "printing" only on `confirmed`.
- [ ] Cancel is reachable from every screen and from voice. Note: operations are queued, so a cancel issued during a start waits for that start's confirmation window (`startConfirmTimeoutMs`, default 20 s); the UI must say "cancelling…" meanwhile and point to the printer's own screen if it does not confirm.
- [ ] The user signs off on Phase 5 in `docs/PHASES.md`.

Until then: `printControlsEnabled: false`, and Morphix only observes.
