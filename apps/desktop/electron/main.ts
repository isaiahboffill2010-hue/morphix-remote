// Morphix — Electron main process (Phase 1: local foundation).
import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { arch, platform } from "node:os";

import { IPC, type AppSettings, type AssistantTurn, type GenerationProgress, type ModelVersion, type PrinterStatus, type Project } from "@morphix/shared";
import { transition, type WorkflowState } from "@morphix/domain";
import { Logger, Storage, safeId } from "@morphix/storage";
import { MorphixDb, type Row } from "@morphix/database";
import { PrinterObserver, TcpTransport } from "@morphix/printer";
import { DemoGenerator, type ModelGenerator } from "@morphix/meshy";
import { DemoAssistant, type Assistant } from "@morphix/gemini";

const APP_DIR = resolve(__dirname, "..");
const RENDERER_DIR = join(APP_DIR, "dist", "renderer");
const WINDOWED = process.env.MORPHIX_WINDOWED === "1";
const SMOKE = process.env.MORPHIX_SMOKE === "1";

// Prefer native Wayland on the Pi's labwc session (falls back to X11 elsewhere).
app.commandLine.appendSwitch("ozone-platform-hint", "auto");

const storage = new Storage();
storage.init();
loadEnvFile(storage.path("config", "morphix.env"));
const log = new Logger(storage);

const PRINTER_HOST = process.env.MORPHIX_PRINTER_HOST || "192.168.10.51";
const CAMERA_BASE = `http://${PRINTER_HOST}:8080`;
const POLL_SECONDS = Number(process.env.MORPHIX_PRINTER_POLL_SECONDS || 5);

let db: MorphixDb;
let win: BrowserWindow | null = null;
let origin = "";
const generator: ModelGenerator = new DemoGenerator();
const assistant: Assistant = new DemoAssistant();
const printer = new PrinterObserver(new TcpTransport(PRINTER_HOST), onPrinterStatus);

process.on("uncaughtException", (e) => log.write("error", "uncaughtException", { message: e.message, stack: e.stack }));
process.on("unhandledRejection", (e) => log.write("error", "unhandledRejection", { reason: String(e) }));

// ---------------------------------------------------------------------------
function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const has = (k: string) => Boolean(process.env[k] && process.env[k]!.trim());
const now = () => new Date().toISOString();
const libraryUrl = (rel: string | null | undefined) => (rel ? `${origin}/library/${rel}` : null);

function settings(): AppSettings {
  return {
    storageRoot: storage.root,
    printerHost: PRINTER_HOST,
    cameraStreamUrl: `${CAMERA_BASE}/?action=stream`,
    cameraSnapshotUrl: `${CAMERA_BASE}/?action=snapshot`,
    printerPollSeconds: POLL_SECONDS,
    demoMode: true,
    keys: {
      gemini: has("GEMINI_API_KEY"),
      meshy: has("MESHY_API_KEY"),
      vultr: has("VULTR_API_KEY"),
      tiger: has("TIGER_DATABASE_URL"),
      swarms: has("SWARMS_API_KEY"),
      auth0: has("AUTH0_DOMAIN") && has("AUTH0_CLIENT_ID"),
    },
    printControlsEnabled: false,
  };
}

function toProject(r: Row): Project {
  const thumb = r.latest_version_id
    ? db.get("SELECT thumbnail_rel_path FROM model_versions WHERE id = ?", [r.latest_version_id])
    : undefined;
  return {
    id: String(r.id),
    title: String(r.title),
    prompt: String(r.prompt),
    state: r.state as WorkflowState,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    latestVersionId: r.latest_version_id ? String(r.latest_version_id) : null,
    thumbnailUrl: libraryUrl(thumb?.thumbnail_rel_path as string | undefined),
  };
}

function toVersion(r: Row): ModelVersion {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    version: Number(r.version),
    source: r.source as ModelVersion["source"],
    format: r.format as ModelVersion["format"],
    url: libraryUrl(String(r.rel_path))!,
    bytes: Number(r.bytes),
    targetHeightMm: r.target_height_mm == null ? null : Number(r.target_height_mm),
    createdAt: String(r.created_at),
  };
}

function setProjectState(id: string, to: WorkflowState): void {
  const r = db.get("SELECT state FROM projects WHERE id = ?", [id]);
  if (!r) throw new Error("project not found");
  const next = transition(r.state as WorkflowState, to, { printControlsEnabled: false });
  db.run("UPDATE projects SET state = ?, updated_at = ? WHERE id = ?", [next, now(), id]);
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function onPrinterStatus(s: PrinterStatus, prev: PrinterStatus): void {
  send(IPC.printerStatusEvent, s);
  if (!db) return;
  if (s.online !== prev.online || s.machine !== prev.machine) {
    const kind = s.online ? `status:${s.machine ?? "unknown"}` : "offline";
    db.run("INSERT INTO printer_events(at, kind, detail) VALUES (?, ?, ?)", [now(), kind, s.error ?? s.currentFile ?? null]);
    log.write("info", `printer ${kind}`, s.error ? { error: s.error } : undefined);
  }
}

// ---------------------------------------------------------------------------
// Generation workflow (demo adapter in Phase 1)

async function runGeneration(projectId: string, taskId: string, prompt: string): Promise<void> {
  const report = (p: Omit<GenerationProgress, "taskId" | "projectId">) =>
    send(IPC.generationProgress, { taskId, projectId, ...p } satisfies GenerationProgress);
  try {
    const model = await generator.generate(prompt, (u) => {
      db.run("UPDATE generation_tasks SET status = ?, progress = ?, updated_at = ? WHERE id = ?", [u.status, u.progress, now(), taskId]);
      if (u.status !== "succeeded") report(u);
    });
    const versionId = randomUUID();
    const n = Number(db.get("SELECT COUNT(*) AS n FROM model_versions WHERE project_id = ?", [projectId])?.n ?? 0) + 1;
    const file = join(storage.modelDir(projectId, versionId), `model.${model.format}`);
    storage.writeAtomic(file, model.data);
    const rel = storage.relative(file);
    db.run(
      "INSERT INTO model_versions(id, project_id, version, source, format, rel_path, bytes, created_at) VALUES (?,?,?,?,?,?,?,?)",
      [versionId, projectId, n, generator.name, model.format, rel, model.data.length, now()],
    );
    db.run("INSERT INTO assets(id, version_id, kind, rel_path, bytes, sha256, created_at) VALUES (?,?,?,?,?,?,?)", [
      randomUUID(), versionId, model.format, rel, model.data.length, createHash("sha256").update(model.data).digest("hex"), now(),
    ]);
    db.run("UPDATE projects SET latest_version_id = ?, updated_at = ? WHERE id = ?", [versionId, now(), projectId]);
    db.run("UPDATE generation_tasks SET status = 'succeeded', progress = 100, updated_at = ? WHERE id = ?", [now(), taskId]);
    setProjectState(projectId, "reviewing");
    db.flush();
    log.write("info", "model generated", { projectId, versionId, bytes: model.data.length, source: generator.name });
    report({ status: "succeeded", progress: 100, stage: "Model ready", versionId });
  } catch (e) {
    const msg = (e as Error).message;
    db.run("UPDATE generation_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", [msg, now(), taskId]);
    try {
      setProjectState(projectId, "failed");
    } catch {
      /* already failed */
    }
    log.write("error", "generation failed", { projectId, error: msg });
    report({ status: "failed", progress: 0, stage: "Failed", error: msg });
  }
}

function wav(pcm16: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm16.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([h, pcm16]);
}

function addTurn(role: "user" | "assistant", text: string, audioRel?: string): AssistantTurn {
  const turn = { id: randomUUID(), role, text, createdAt: now() };
  db.run("INSERT INTO conversation(id, role, text, audio_rel_path, created_at) VALUES (?,?,?,?,?)", [
    turn.id, role, text, audioRel ?? null, turn.createdAt,
  ]);
  return { ...turn, audioUrl: libraryUrl(audioRel) ?? undefined };
}

// ---------------------------------------------------------------------------
// IPC — every handler checks the sender is our own window.

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!event.senderFrame || !event.senderFrame.url.startsWith(origin + "/")) {
      throw new Error("IPC from untrusted frame");
    }
    return fn(...(args as A));
  });
}

function registerIpc(): void {
  handle(IPC.getSettings, () => settings());
  handle(IPC.getSystemInfo, () => ({
    version: app.getVersion(),
    platform: platform(),
    arch: arch(),
    storageRoot: storage.root,
    ...storage.disk(),
    logFile: log.file(),
    uptimeSeconds: Math.round(process.uptime()),
  }));
  handle(IPC.recentLogs, (lines?: number) => log.tail(Math.min(Number(lines) || 100, 500)));
  ipcMain.on(IPC.log, (event, level: "info" | "warn" | "error", message: string) => {
    if (event.senderFrame?.url.startsWith(origin + "/")) log.write(level, `[renderer] ${String(message).slice(0, 2000)}`);
  });

  handle(IPC.listProjects, () => db.all("SELECT * FROM projects ORDER BY updated_at DESC").map(toProject));
  handle(IPC.getProject, (id: string) => {
    const r = db.get("SELECT * FROM projects WHERE id = ?", [safeId(id)]);
    if (!r) return null;
    return {
      project: toProject(r),
      versions: db.all("SELECT * FROM model_versions WHERE project_id = ? ORDER BY version DESC", [id]).map(toVersion),
    };
  });
  handle(IPC.createProjectFromPrompt, (prompt: string) => {
    const text = String(prompt ?? "").trim().slice(0, 500);
    if (!text) throw new Error("describe what to make first");
    const id = randomUUID();
    const taskId = randomUUID();
    const t = now();
    db.run("INSERT INTO projects(id, title, prompt, state, created_at, updated_at) VALUES (?,?,?,?,?,?)", [
      id, text.slice(0, 60), text, "idea", t, t,
    ]);
    setProjectState(id, "generating");
    db.run(
      "INSERT INTO generation_tasks(id, project_id, provider, kind, status, prompt, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [taskId, id, generator.name, "preview", "queued", text, t, t],
    );
    void runGeneration(id, taskId, text);
    return { project: toProject(db.get("SELECT * FROM projects WHERE id = ?", [id])!), taskId };
  });
  handle(IPC.setTargetHeight, (versionId: string, heightMm: number) => {
    const h = Number(heightMm);
    if (!(h > 0 && h <= 1000)) throw new Error("height must be between 0 and 1000 mm");
    db.run("UPDATE model_versions SET target_height_mm = ? WHERE id = ?", [h, safeId(versionId)]);
    const r = db.get("SELECT * FROM model_versions WHERE id = ?", [versionId]);
    if (!r) throw new Error("model not found");
    return toVersion(r);
  });
  handle(IPC.saveThumbnail, (versionId: string, dataUrl: string) => {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m) throw new Error("expected a PNG data URL");
    const png = Buffer.from(m[1], "base64");
    if (png.length > 5_000_000) throw new Error("thumbnail too large");
    const file = storage.path("previews", `${safeId(versionId)}.png`);
    storage.writeAtomic(file, png);
    db.run("UPDATE model_versions SET thumbnail_rel_path = ? WHERE id = ?", [storage.relative(file), versionId]);
  });

  handle(IPC.submitRecording, async (pcm: ArrayBuffer, sampleRate: number) => {
    const buf = Buffer.from(pcm);
    if (buf.length > 16000 * 2 * 120) throw new Error("recording too long (2 minute limit)");
    const rate = Math.round(Number(sampleRate)) || 16000;
    const file = storage.path("cache", "recordings", `${randomUUID()}.wav`);
    storage.writeAtomic(file, wav(buf, rate));
    const { transcript, reply } = await assistant.hearAudio(buf, rate);
    const turn = addTurn("user", transcript, storage.relative(file));
    return { turn, reply: addTurn("assistant", reply.text), proposedPrompt: reply.proposedPrompt };
  });
  handle(IPC.sendText, async (text: string) => {
    const t = String(text ?? "").slice(0, 500);
    const turn = addTurn("user", t);
    const reply = await assistant.hearText(t);
    return { turn, reply: addTurn("assistant", reply.text), proposedPrompt: reply.proposedPrompt };
  });
  handle(IPC.conversation, () =>
    db
      .all("SELECT * FROM conversation ORDER BY created_at DESC LIMIT 50")
      .reverse()
      .map((r) => ({
        id: String(r.id),
        role: r.role as "user" | "assistant",
        text: String(r.text),
        audioUrl: libraryUrl(r.audio_rel_path as string | null) ?? undefined,
        createdAt: String(r.created_at),
      })),
  );

  handle(IPC.printerStatus, () => printer.status);
  handle(IPC.printerInfo, () => printer.info());
}

// ---------------------------------------------------------------------------
// Local server (127.0.0.1 only): the renderer UI plus read-only model assets.
// Serving from http://127.0.0.1 gives the page a secure context (microphone)
// while still allowing the printer's plain-HTTP camera stream.

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".wav": "audio/wav", ".woff2": "font/woff2",
  ".stl": "model/stl", ".glb": "model/gltf-binary", ".wasm": "application/wasm",
};
const LIBRARY_DIRS = ["models", "previews", "cache/recordings", "snapshots"];

function startServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let file: string | null = null;
    if (url.pathname.startsWith("/library/")) {
      const rel = decodeURIComponent(url.pathname.slice("/library/".length));
      try {
        const p = storage.path(rel);
        if (LIBRARY_DIRS.some((d) => p.startsWith(storage.path(d) + sep))) file = p;
      } catch {
        file = null;
      }
    } else {
      const p = resolve(RENDERER_DIR, "." + (url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)));
      if (p.startsWith(RENDERER_DIR + sep)) file = p;
    }
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// ---------------------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1024,
    height: 600,
    fullscreen: !WINDOWED,
    autoHideMenuBar: true,
    backgroundColor: "#0e1117",
    show: !SMOKE,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(origin + "/")) {
      e.preventDefault();
      log.write("warn", "blocked navigation", { url });
    }
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    log.write("error", "renderer crashed, reloading", details);
    setTimeout(() => win?.loadURL(origin + "/"), 1000);
  });
  win.webContents.on("console-message", (...args: unknown[]) => {
    // Newer Electron passes one event object; older versions pass (event, level, message).
    const ev = args[0] as { level?: unknown; message?: unknown };
    const level = String(ev.level ?? args[1]);
    const message = String(ev.message ?? args[2]);
    if (level === "error" || level === "3") log.write("error", `[console] ${message}`);
    else if (level === "warning" || level === "2") log.write("warn", `[console] ${message}`);
  });
  if (SMOKE) {
    win.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 2500));
      const text = await win!.webContents.executeJavaScript("document.body.innerText");
      // End-to-end through the real bridge: prompt -> demo model -> stored -> served.
      const flow = await win!.webContents.executeJavaScript(`(async () => {
        const m = window.morphix;
        const r = await m.sendText("a small vase");
        const done = new Promise((res) => { const off = m.onGenerationProgress((p) => {
          if (p.status === "succeeded" || p.status === "failed") { off(); res(p); } }); });
        const { project } = await m.createProjectFromPrompt(r.proposedPrompt);
        const p = await done;
        const d = await m.getProject(project.id);
        const v = d.versions[0];
        const bytes = (await (await fetch(v.url)).arrayBuffer()).byteLength;
        const sized = await m.setTargetHeight(v.id, 152.4);
        let blocked = false;
        const probe = v.url.split("/library/")[0] + "/library/..%2F..%2F..%2F..%2Fetc%2Fpasswd";
        try { blocked = (await fetch(probe)).status === 404; } catch { blocked = true; }
        return { status: p.status, state: d.project.state, bytes, fileBytes: v.bytes, height: sized.targetHeightMm, blocked, projects: (await m.listProjects()).length };
      })()`);
      log.write("info", "smoke test", { ok: /Morphix/.test(text), chars: text.length, flow });
      app.quit();
    });
  }
  void win.loadURL(origin + "/");
}

// One Morphix per Pi: a second launch just brings the existing window forward.
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  const wasmDir = dirname(require.resolve("sql.js/dist/sql-wasm.wasm"));
  db = await MorphixDb.open(storage, wasmDir);
  const recovered = db.recoverInterruptedTasks();
  db.backup();
  setInterval(() => db.backup(), 24 * 3600 * 1000);
  log.write("info", "Morphix starting", { storage: storage.root, printer: PRINTER_HOST, recovered, demo: true });

  const server = await startServer();
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  // Microphone only, only for our own page. Everything else is denied.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ok =
      permission === "media" &&
      details.requestingUrl.startsWith(origin + "/") &&
      (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === "audio") !== false;
    cb(ok);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    permission === "media" && requestingOrigin === origin,
  );

  registerIpc();
  createWindow();
  printer.start(POLL_SECONDS * 1000);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  printer.stop();
  try {
    db?.close();
  } catch (e) {
    log.write("error", "db close failed", { error: (e as Error).message });
  }
});
