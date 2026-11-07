import { createHash, randomBytes, randomInt } from "node:crypto";
import { chmodSync, createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AssistantTurn, GuardianView, JobView, PrepareSettings, PrepareSummary, PrintControlStatus, SmartModelResult, SmartSearchState } from "@morphix/shared";
import type { PortalBackend, PortalUser, PrinterCommand } from "@morphix/portal";
import { sniffImage } from "@morphix/portal";
import type { Storage } from "@morphix/storage";

type Json = Record<string, unknown>;

export interface RemoteDeps {
  storage: Storage;
  backend: PortalBackend;
  conversation(): AssistantTurn[];
  jobs(): JobView[];
  assistantText(text: string): Promise<void>;
  assistantVoice(pcm16: Buffer, sampleRate: number): Promise<void>;
  setHeight(versionId: string, heightMm: number | null): unknown;
  proposeRefine(versionId: string): unknown;
  prepare(versionId: string, settings: PrepareSettings | "auto"): Promise<PrepareSummary>;
  latestPrint(projectId: string): PrepareSummary | null;
  proposePrint(jobId: string): unknown;
  printStatus(): PrintControlStatus;
  pause(): Promise<{ ok: boolean; message: string }>;
  resume(): Promise<{ ok: boolean; message: string }>;
  cancel(): Promise<{ ok: boolean; message: string }>;
  guardian(): GuardianView;
  guardianAnswer(decision: "stop" | "keep"): Promise<{ ok: boolean; message: string }>;
  smartSearch(): SmartSearchState | null;
  searchModels(query: string): Promise<SmartSearchState>;
  selectModel(id: string): SmartModelResult;
  importModels(input: { resultId: string; files: { name: string; bytes: Buffer }[] }): Promise<{ projectId: string; versionId: string; parts: string[]; warnings: string[] }>;
  log(line: string): void;
}

interface Device { name: string; hash: string; createdAt: string; lastSeenAt: string }
interface PairState { codeHash: string; expiresAt: string; devices: Device[] }

const USER: PortalUser = { sub: "morphix-remote", email: "paired-device@morphix.local", name: "Paired phone", isAdmin: true };
const json = (res: ServerResponse, status: number, body: unknown) => {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(bytes);
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const cleanId = (s: string) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(s)) throw new Error("invalid id");
  return s;
};

export class MorphixRemote {
  private server: Server | null = null;
  private stateFile: string;
  private codeFile: string;
  private state: PairState;
  private currentCode = "";
  private failures = new Map<string, number[]>();

  constructor(private d: RemoteDeps, private options: { host: string; port: number; allowedOrigins: string[] }) {
    this.stateFile = d.storage.path("remote", "devices.json");
    this.codeFile = d.storage.path("remote", "pairing-code.txt");
    this.state = this.load();
  }

  private load(): PairState {
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as PairState;
      const savedCode = readFileSync(this.codeFile, "utf8").match(/\d{8}/)?.[0] ?? "";
      if (Array.isArray(parsed.devices) && savedCode && hash(savedCode) === parsed.codeHash && Date.parse(parsed.expiresAt) > Date.now()) {
        this.currentCode = savedCode;
        return { ...parsed, devices: parsed.devices.slice(0, 20) };
      }
    } catch { /* first run */ }
    return this.rotateCode([]);
  }

  private rotateCode(devices = this.state?.devices ?? []): PairState {
    const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
    this.currentCode = code;
    const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
    const next = { codeHash: hash(code), expiresAt, devices };
    this.d.storage.writeAtomic(this.stateFile, JSON.stringify(next, null, 2));
    this.d.storage.writeAtomic(this.codeFile, `Morphix Remote pairing code: ${code}\nExpires: ${expiresAt}\n`);
    try { chmodSync(this.codeFile, 0o600); } catch { /* Windows/dev */ }
    this.d.log(`pairing code written to ${this.codeFile}`);
    return next;
  }

  private save() { this.d.storage.writeAtomic(this.stateFile, JSON.stringify(this.state, null, 2)); }

  async start(): Promise<{ url: string; codeFile: string }> {
    if (this.server) throw new Error("remote server already started");
    this.server = createServer((req, res) => void this.route(req, res).catch((e) => {
      this.d.log(`request failed: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: "request_failed", message: (e as Error).message }); else res.end();
    }));
    await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(this.options.port, this.options.host, resolve));
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    return { url: `http://${this.options.host}:${port}`, codeFile: this.codeFile };
  }

  async stop() { if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve())); this.server = null; }

  pairingLink(siteUrl: string): { url: string; expiresAt: string } {
    if (!siteUrl || !/^https:\/\//.test(siteUrl)) throw new Error("MORPHIX_REMOTE_SITE_URL must be an https:// URL");
    return { url: `${siteUrl.replace(/\/$/, "")}/#pair=${encodeURIComponent(this.currentCode)}`, expiresAt: this.state.expiresAt };
  }

  private origin(req: IncomingMessage, res: ServerResponse): boolean {
    const value = String(req.headers.origin ?? "");
    if (value && !this.options.allowedOrigins.includes(value)) { json(res, 403, { error: "origin_not_allowed" }); return false; }
    if (value) {
      res.setHeader("Access-Control-Allow-Origin", value);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    }
    return true;
  }

  private device(req: IncomingMessage): Device | null {
    const m = /^Bearer\s+([A-Za-z0-9_-]{40,})$/.exec(String(req.headers.authorization ?? ""));
    if (!m) return null;
    const h = hash(m[1]);
    const d = this.state.devices.find((x) => x.hash === h) ?? null;
    if (d) { d.lastSeenAt = new Date().toISOString(); this.save(); }
    return d;
  }

  private async body(req: IncomingMessage, max = 1_000_000): Promise<Buffer> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > max) throw new Error("request is too large"); chunks.push(b); }
    return Buffer.concat(chunks);
  }
  private async input(req: IncomingMessage, max?: number): Promise<Json> {
    const b = await this.body(req, max); if (!b.length) return {};
    const v = JSON.parse(b.toString("utf8")); if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected an object"); return v as Json;
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    if (!this.origin(req, res)) return;
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    const u = new URL(req.url ?? "/", "http://remote.local");
    if (req.method === "GET" && u.pathname === "/api/health") { json(res, 200, { ok: true, service: "Morphix Remote" }); return; }
    if (req.method === "POST" && u.pathname === "/api/pair") { await this.pair(req, res); return; }
    const device = this.device(req);
    if (!device) { json(res, 401, { error: "pairing_required" }); return; }

    if (req.method === "GET" && u.pathname === "/api/state") {
      const [me, projects, actions, printer] = await Promise.all([this.d.backend.me(USER), this.d.backend.listProjects(USER), this.d.backend.pendingActions(USER), this.d.backend.printerStatus(USER)]);
      json(res, 200, { me, projects, actions, printer, print: this.d.printStatus(), guardian: this.d.guardian(), conversation: this.d.conversation(), jobs: this.d.jobs(), smartSearch: this.d.smartSearch(), device: { name: device.name } }); return;
    }
    if (req.method === "GET" && u.pathname === "/api/projects") { json(res, 200, { projects: await this.d.backend.listProjects(USER) }); return; }
    let m = /^\/api\/projects\/([^/]+)$/.exec(u.pathname);
    if (req.method === "GET" && m) { const p = await this.d.backend.getProject(cleanId(m[1]), USER); json(res, p ? 200 : 404, { project: p }); return; }
    m = /^\/api\/models\/([^/]+)$/.exec(u.pathname);
    if (req.method === "GET" && m) { const f = await this.d.backend.modelFile(cleanId(m[1]), USER); if (!f) { json(res, 404, { error: "not_found" }); return; } this.file(res, f.path, f.format === "glb" ? "model/gltf-binary" : "model/stl"); return; }
    m = /^\/api\/thumbnails\/([^/]+)$/.exec(u.pathname);
    if (req.method === "GET" && m) { const f = await this.d.backend.thumbnailFile?.(cleanId(m[1]), USER); if (!f) { json(res, 404, { error: "not_found" }); return; } this.file(res, f.path, `image/${f.format === "jpg" ? "jpeg" : f.format}`); return; }
    if (req.method === "GET" && u.pathname === "/api/camera/snapshot") { await this.cameraSnapshot(res); return; }
    if (req.method === "GET" && u.pathname === "/api/camera") { const c = await this.d.backend.cameraStream(USER); if (!c) { json(res, 503, { error: "camera_unavailable" }); return; } res.writeHead(200, { "Content-Type": c.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); c.stream.pipe(res); req.once("close", () => c.stream.destroy()); return; }
    if (req.method === "GET" && u.pathname === "/api/conversation") { json(res, 200, { conversation: this.d.conversation() }); return; }
    if (req.method === "POST" && u.pathname === "/api/models/search") { const b = await this.input(req); json(res, 200, await this.d.searchModels(String(b.query ?? ""))); return; }
    if (req.method === "POST" && u.pathname === "/api/models/select") { const b = await this.input(req); json(res, 200, { result: this.d.selectModel(String(b.id ?? "")) }); return; }
    if (req.method === "POST" && u.pathname === "/api/models/import") { const b = await this.input(req, 80_000_000); const raw = Array.isArray(b.files) ? b.files : []; if (!raw.length || raw.length > 20) throw new Error("Choose 1 to 20 model files."); const files = raw.map((v:any) => { const bytes=Buffer.from(String(v.data??""),"base64"); if(!bytes.length||bytes.length>20_000_000) throw new Error("Each model file must be under 20 MB."); return {name:String(v.name??"model.stl").slice(0,120),bytes}; }); json(res, 201, await this.d.importModels({ resultId:String(b.resultId??""), files })); return; }
    if (req.method === "POST" && u.pathname === "/api/assistant/text") { const b = await this.input(req); const text = String(b.text ?? "").trim().slice(0, 1000); if (!text) throw new Error("message required"); await this.d.assistantText(text); json(res, 202, { ok: true }); return; }
    if (req.method === "POST" && u.pathname === "/api/assistant/voice") { const b = await this.input(req, 9_000_000); const pcm = Buffer.from(String(b.pcm ?? ""), "base64"); const rate = Number(b.sampleRate); if (rate !== 16000 || !pcm.length || pcm.length > 7_680_000) throw new Error("expected up to two minutes of 16 kHz PCM16"); await this.d.assistantVoice(pcm, rate); json(res, 202, { ok: true }); return; }
    if (req.method === "POST" && u.pathname === "/api/requests/text") { const b = await this.input(req); json(res, 202, await this.d.backend.createTextRequest(String(b.prompt ?? "").trim().slice(0, 1000), USER)); return; }
    if (req.method === "POST" && u.pathname === "/api/requests/photo") { await this.photo(req, res); return; }
    if (req.method === "POST" && u.pathname === "/api/actions/confirm") { const b = await this.input(req); json(res, 200, await this.d.backend.confirmAction(cleanId(String(b.id ?? "")), USER)); return; }
    if (req.method === "POST" && u.pathname === "/api/actions/cancel") { const b = await this.input(req); json(res, 200, await this.d.backend.cancelAction(cleanId(String(b.id ?? "")), USER)); return; }
    m = /^\/api\/versions\/([^/]+)\/(height|refine|prepare)$/.exec(u.pathname);
    if (req.method === "POST" && m) { const id = cleanId(m[1]), b = await this.input(req); if (m[2] === "height") json(res, 200, { version: this.d.setHeight(id, b.heightMm == null ? null : Number(b.heightMm)) }); else if (m[2] === "refine") json(res, 200, { action: this.d.proposeRefine(id) }); else json(res, 200, { summary: await this.d.prepare(id, b.settings === "auto" || !b.settings ? "auto" : b.settings as unknown as PrepareSettings) }); return; }
    m = /^\/api\/projects\/([^/]+)\/latest-print$/.exec(u.pathname);
    if (req.method === "GET" && m) { json(res, 200, { summary: this.d.latestPrint(cleanId(m[1])) }); return; }
    if (req.method === "POST" && u.pathname === "/api/print/request") { const b = await this.input(req); json(res, 200, { action: this.d.proposePrint(cleanId(String(b.jobId ?? ""))) }); return; }
    if (req.method === "POST" && u.pathname === "/api/print/control") { const b = await this.input(req); const cmd = String(b.command); const result = cmd === "pause" ? await this.d.pause() : cmd === "resume" ? await this.d.resume() : cmd === "cancel" ? await this.d.cancel() : null; if (!result) { json(res, 400, { error: "invalid_command" }); return; } json(res, result.ok ? 200 : 409, result); return; }
    if (req.method === "POST" && u.pathname === "/api/printer/command") { const b = await this.input(req); json(res, 200, await this.d.backend.printerCommand(b as unknown as PrinterCommand, USER)); return; }
    if (req.method === "POST" && u.pathname === "/api/guardian/answer") { const b = await this.input(req); const decision = b.decision === "stop" ? "stop" : b.decision === "keep" ? "keep" : null; if (!decision) throw new Error("invalid decision"); json(res, 200, await this.d.guardianAnswer(decision)); return; }
    if (req.method === "DELETE" && u.pathname === "/api/device") { this.state.devices = this.state.devices.filter((x) => x.hash !== device.hash); this.save(); json(res, 200, { ok: true }); return; }
    json(res, 404, { error: "not_found" });
  }

  private file(res: ServerResponse, path: string, contentType: string) {
    if (!existsSync(path)) { json(res, 404, { error: "not_found" }); return; }
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); createReadStream(path).pipe(res);
  }

  private async cameraSnapshot(res: ServerResponse) {
    const camera = await this.d.backend.cameraStream(USER);
    if (!camera) { json(res, 503, { error: "camera_unavailable" }); return; }
    let data = Buffer.alloc(0), frame: Buffer | null = null;
    const timer = setTimeout(() => camera.stream.destroy(new Error("camera snapshot timeout")), 8_000);
    try {
      for await (const chunk of camera.stream) {
        data = Buffer.concat([data, Buffer.from(chunk)]);
        const start = data.indexOf(Buffer.from([0xff, 0xd8]));
        const end = start >= 0 ? data.indexOf(Buffer.from([0xff, 0xd9]), start + 2) : -1;
        if (start >= 0 && end > start) { frame = data.subarray(start, end + 2); break; }
        if (data.length > 4_000_000) data = data.subarray(-1_000_000);
      }
    } catch { /* reported below */ }
    finally { clearTimeout(timer); camera.stream.destroy(); }
    if (!frame) { json(res, 503, { error: "camera_frame_unavailable" }); return; }
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": frame.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(frame);
  }

  private async pair(req: IncomingMessage, res: ServerResponse) {
    const ip = req.socket.remoteAddress ?? "unknown", now = Date.now();
    const recent = (this.failures.get(ip) ?? []).filter((x) => now - x < 10 * 60_000);
    if (recent.length >= 8) { json(res, 429, { error: "too_many_attempts" }); return; }
    const b = await this.input(req), code = String(b.code ?? "").replace(/\D/g, ""), name = String(b.name ?? "Phone").trim().slice(0, 40) || "Phone";
    if (Date.parse(this.state.expiresAt) < now || hash(code) !== this.state.codeHash) { recent.push(now); this.failures.set(ip, recent); json(res, 401, { error: "invalid_pairing_code" }); return; }
    const token = randomBytes(32).toString("base64url"), at = new Date().toISOString();
    this.state.devices.push({ name, hash: hash(token), createdAt: at, lastSeenAt: at });
    this.state = this.rotateCode(this.state.devices.slice(-20));
    json(res, 200, { token, device: { name }, pairedAt: at });
  }

  private async photo(req: IncomingMessage, res: ServerResponse) {
    const b = await this.input(req, 48_000_000); const raw = Array.isArray(b.images) ? b.images : [];
    if (!raw.length || raw.length > 6) throw new Error("add 1 to 6 images");
    const images = raw.map((v, i) => { const x = v as Json, bytes = Buffer.from(String(x.data ?? ""), "base64"); if (!bytes.length || bytes.length > 12_000_000) throw new Error("each image must be under 12 MB"); const mime = sniffImage(bytes); if (!mime) throw new Error("use JPEG, PNG, WebP or HEIC images"); return { name: String(x.name ?? `photo-${i + 1}`).slice(0, 100), mime, bytes }; });
    const accepted = await this.d.backend.createPhotoRequest({ images, description: String(b.description ?? "").trim().slice(0, 1000), measurements: [], referenceObject: "none", user: USER });
    json(res, 202, accepted);
  }
}

