// QD330 job control (Phase 5). Separate from the observation-only PrinterObserver.
//
// Safety model (see docs/PHASE5.md):
//  - A controller is inert unless constructed with `enabled: true`; every control
//    method throws ControllerDisabledError otherwise.
//  - Upload, start and resume need a PrintAuthorization bound to the job and file.
//    Start and resume consume it. Pause and cancel need no token but are logged.
//  - A result is `confirmed` only when the printer's own status (M119/M27) shows
//    the expected change. Nothing is reported as done on a reply alone.
//  - One operation at a time; read-only status polls can share the same queue via
//    `controller.transport` so the observer never collides with a control session.
import { Socket } from "node:net";
import type { PrinterStatus } from "@morphix/shared";
import type { PrinterTransport } from "./index";
import { defaultPrintAuthorizer, type ApprovalSource, type PrintAuthorization, type PrintAuthorizer } from "./auth";
import { assertStoredFileName, sanitizeFileName } from "./names";
import {
  assertReadOnly,
  baseName,
  buildPacket,
  cleanReply,
  commandVerb,
  encodeCommand,
  findReplyEnd,
  isAcknowledged,
  PACKET_DATA_SIZE,
  packetCount,
  parseFileList,
  parseStatus,
  REPLY_ERROR,
} from "./protocol";

export class ControllerDisabledError extends Error {}
export class ControlRefusedError extends Error {}
export class PrinterReplyTimeout extends Error {}
export class PrinterConnectionClosed extends Error {}

export const STATUS_READY = "READY";
export const STATUS_BUILDING = "BUILDING_FROM_SD";
/** Unverified on the real printer: what MachineStatus reads after M25. Override via `pausedStatuses`. */
export const DEFAULT_PAUSED_STATUSES = ["PAUSED"];

export type ControlOp = "listFiles" | "upload" | "start" | "pause" | "resume" | "cancel";
export type RequestedBy = ApprovalSource | "guardian" | "system";

export interface ControlResult<T = undefined> {
  op: ControlOp;
  /** The control command reached the socket. */
  sent: boolean;
  /** The printer replied "CMD <X> Received." ... "ok" with no error text. */
  acknowledged: boolean;
  /** The printer's status showed the expected change. The only field that means "done". */
  confirmed: boolean;
  /** false for commands whose behaviour has not been verified on the real QD330 (M24, M25). */
  protocolVerified: boolean;
  /** Last status read during the operation. */
  status?: PrinterStatus;
  /** Raw reply to the control command. */
  reply?: string;
  error?: string;
  data?: T;
}

export interface ControlLogEntry {
  at: string;
  op: ControlOp;
  outcome: "rejected" | "failed" | "unconfirmed" | "confirmed";
  jobId?: string;
  fileName?: string;
  approvedBy?: ApprovalSource;
  requestedBy?: RequestedBy;
  reason?: string;
  sent: boolean;
  acknowledged: boolean;
  confirmed: boolean;
  error?: string;
  status?: string;
}

export interface StoredFile {
  /** Basename, e.g. "dance.g" — what M23/startPrint take. */
  name: string;
  /** Path as reported by M661, e.g. "/data/dance.g". */
  path: string;
}

export interface UploadProgress {
  bytesSent: number;
  totalBytes: number;
  packetsSent: number;
  totalPackets: number;
  percent: number;
}

export interface QD330ControllerOptions {
  /** Must be given explicitly. false = every control method throws. */
  enabled: boolean;
  host: string;
  port?: number;
  connectTimeoutMs?: number;
  replyTimeoutMs?: number;
  /** Reply timeout for M23 (opening a file can be slow). Default 10 000. */
  startReplyTimeoutMs?: number;
  /** Reply timeout for M29 (the printer finishes writing the file). Default 15 000. */
  uploadFinishTimeoutMs?: number;
  /** How long to wait for BUILDING_FROM_SD after M23. */
  startConfirmTimeoutMs?: number;
  /** How long to wait for the expected status after M25/M24/M26. */
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Pause between upload packets. Only single-packet uploads are verified on hardware. */
  packetDelayMs?: number;
  maxUploadBytes?: number;
  /** Accept plain .g files (stalled at 0% on the real printer). Default false. */
  allowPlainGcode?: boolean;
  /** MachineStatus values that mean "paused". Unverified; default ["PAUSED"]. */
  pausedStatuses?: string[];
  authorizer?: PrintAuthorizer;
  log?: (entry: ControlLogEntry) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One M601 S1 … M602 control session over TCP. Binary-safe. */
class ControlSession {
  private buf = Buffer.alloc(0);
  private closed: Error | null = null;
  private waiter: { complete: (b: Buffer) => number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  /** True between M28 and the last packet: the printer treats incoming bytes as file data. */
  inDataMode = false;

  private constructor(private sock: Socket, private replyTimeoutMs: number) {
    sock.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.check();
    });
    sock.on("error", (e) => this.fail(new PrinterConnectionClosed(`printer connection error: ${e.message}`)));
    sock.on("close", () => this.fail(new PrinterConnectionClosed("printer closed the connection")));
  }

  static open(host: string, port: number, connectTimeoutMs: number, replyTimeoutMs: number): Promise<ControlSession> {
    return new Promise((resolve, reject) => {
      const sock = new Socket();
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new PrinterReplyTimeout(`cannot reach printer at ${host}:${port}: connect timeout`));
      }, connectTimeoutMs);
      const onError = (e: Error) => {
        clearTimeout(timer);
        reject(new PrinterConnectionClosed(`cannot reach printer at ${host}:${port}: ${e.message}`));
      };
      sock.once("error", onError);
      sock.connect(port, host, async () => {
        clearTimeout(timer);
        sock.off("error", onError);
        const s = new ControlSession(sock, replyTimeoutMs);
        try {
          const reply = await s.command("M601 S1");
          if (!/Control Success/i.test(reply)) throw new ControlRefusedError(`printer refused control: ${cleanReply(reply) || "(no reply text)"}`);
          resolve(s);
        } catch (e) {
          s.destroy();
          reject(e);
        }
      });
    });
  }

  private fail(e: Error) {
    if (!this.closed) this.closed = e;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(e);
  }

  private check() {
    const w = this.waiter;
    if (!w) return;
    let n: number;
    try {
      n = w.complete(this.buf);
    } catch (e) {
      this.waiter = null;
      w.reject(e as Error);
      return;
    }
    if (n < 0) return;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    this.waiter = null;
    w.resolve(out);
  }

  private wait(complete: (b: Buffer) => number, timeoutMs: number, what: string): Promise<Buffer> {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        const partial = cleanReply(this.buf.toString("latin1")).slice(0, 200);
        reject(new PrinterReplyTimeout(`no complete reply to ${what} within ${timeoutMs}ms${partial ? ` (got: ${partial})` : ""}`));
      }, timeoutMs);
      this.waiter = {
        complete,
        resolve: (b) => (clearTimeout(timer), resolve(b)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      this.check();
    });
  }

  async write(data: Buffer): Promise<void> {
    if (this.closed) throw this.closed;
    await new Promise<void>((resolve, reject) => this.sock.write(data, (e) => (e ? reject(e) : resolve())));
  }

  /** Data received outside a command/reply exchange (e.g. during upload packets). */
  pendingText(): string {
    return this.buf.toString("latin1");
  }

  async command(cmd: string, timeoutMs = this.replyTimeoutMs): Promise<string> {
    const verb = commandVerb(cmd);
    this.buf = Buffer.alloc(0); // anything still buffered belongs to an earlier exchange
    await this.write(Buffer.from(encodeCommand(cmd), "utf8"));
    const out = await this.wait((b) => findReplyEnd(b.toString("latin1"), verb), timeoutMs, cmd);
    return out.toString("utf8");
  }

  async commandBinary(cmd: string, complete: (b: Buffer) => number, timeoutMs = this.replyTimeoutMs): Promise<Buffer> {
    this.buf = Buffer.alloc(0);
    await this.write(Buffer.from(encodeCommand(cmd), "utf8"));
    return this.wait(complete, timeoutMs, cmd);
  }

  async release(): Promise<void> {
    if (!this.closed && !this.inDataMode) {
      try {
        await this.command("M602", Math.min(this.replyTimeoutMs, 2000));
      } catch {
        // best effort; the socket is closed below either way
      }
    }
    this.destroy();
  }

  destroy() {
    this.closed ??= new PrinterConnectionClosed("session closed");
    this.sock.destroy();
  }
}

interface OpMeta {
  jobId?: string;
  fileName?: string;
  approvedBy?: ApprovalSource;
  requestedBy?: RequestedBy;
  reason?: string;
}

function fileMatches(current: string | undefined, name: string): boolean {
  if (!current) return false;
  const cf = baseName(current).toLowerCase();
  const n = name.toLowerCase();
  return cf === n || cf === n.replace(/\.(gx|g)$/, "");
}

function describe(st: PrinterStatus | undefined): string {
  if (!st) return "unknown";
  return `${st.machine ?? "?"}${st.currentFile ? ` / ${st.currentFile}` : ""}`;
}

export class QD330Controller {
  readonly enabled: boolean;
  private o: Required<Omit<QD330ControllerOptions, "log" | "authorizer">>;
  private authorizer: PrintAuthorizer;
  private logFn: (e: ControlLogEntry) => void;
  private chain: Promise<unknown> = Promise.resolve();

  /** Read-only transport that shares this controller's queue (for PrinterObserver). Works while disabled. */
  readonly transport: PrinterTransport;

  constructor(options: QD330ControllerOptions) {
    if (!options || typeof options.enabled !== "boolean") throw new TypeError("QD330Controller: `enabled` must be given explicitly");
    if (!options.host) throw new TypeError("QD330Controller: host is required");
    this.enabled = options.enabled;
    this.o = {
      enabled: options.enabled,
      host: options.host,
      port: options.port ?? 8899,
      connectTimeoutMs: options.connectTimeoutMs ?? 4000,
      replyTimeoutMs: options.replyTimeoutMs ?? 5000,
      startReplyTimeoutMs: options.startReplyTimeoutMs ?? 10_000,
      uploadFinishTimeoutMs: options.uploadFinishTimeoutMs ?? 15_000,
      startConfirmTimeoutMs: options.startConfirmTimeoutMs ?? 20_000,
      confirmTimeoutMs: options.confirmTimeoutMs ?? 10_000,
      pollIntervalMs: options.pollIntervalMs ?? 1000,
      packetDelayMs: options.packetDelayMs ?? 50,
      maxUploadBytes: options.maxUploadBytes ?? 64 * 1024 * 1024,
      allowPlainGcode: options.allowPlainGcode ?? false,
      pausedStatuses: options.pausedStatuses ?? DEFAULT_PAUSED_STATUSES,
    };
    this.authorizer = options.authorizer ?? defaultPrintAuthorizer;
    this.logFn = options.log ?? (() => undefined);
    this.transport = {
      query: (cmds) => {
        try {
          cmds.forEach(assertReadOnly);
        } catch (e) {
          return Promise.reject(e);
        }
        return this.exclusive(() =>
          this.withSession(async (s) => {
            const out: Record<string, string> = {};
            for (const c of cmds) if (c !== "M601 S1" && c !== "M602") out[c] = cleanReply(await s.command(c));
            return out;
          }),
        );
      },
    };
  }

  // ---- read-only -------------------------------------------------------------

  /** Full status snapshot (M119, M105, M114, M27). Allowed while disabled. */
  async readStatus(): Promise<PrinterStatus> {
    return parseStatus(await this.transport.query(["M119", "M105", "M114", "M27"]));
  }

  // ---- control -----------------------------------------------------------------

  async listFiles(): Promise<ControlResult<StoredFile[]>> {
    this.assertEnabled("listFiles", {});
    return this.run<StoredFile[]>("listFiles", {}, true, async (s, r) => {
      r.data = await this.listIn(s);
      r.sent = r.acknowledged = r.confirmed = true;
    });
  }

  /**
   * Stores `data` on the printer as `name` (sanitised; must be .gx, or .g when
   * allowPlainGcode). Needs a PrintAuthorization for this job and the sanitised
   * name; it is checked but not consumed, so the same approval can then start it.
   * Confirmed when the file appears in M661.
   */
  async uploadFile(
    name: string,
    data: Uint8Array,
    opts: { jobId: string; authorization: PrintAuthorization | undefined; onProgress?: (p: UploadProgress) => void; overwrite?: boolean },
  ): Promise<ControlResult<{ fileName: string; bytes: number; packets: number }>> {
    const meta: OpMeta = { jobId: opts?.jobId };
    this.assertEnabled("upload", meta);
    const fileName = this.guard("upload", meta, () => sanitizeFileName(name, { allowPlainGcode: this.o.allowPlainGcode }));
    meta.fileName = fileName;
    this.guard("upload", meta, () => {
      if (!(data instanceof Uint8Array) || data.length === 0) throw new RangeError("upload data is empty");
      if (data.length > this.o.maxUploadBytes) throw new RangeError(`upload is ${data.length} bytes; limit is ${this.o.maxUploadBytes}`);
      meta.approvedBy = this.authorizer.verify(opts?.authorization, { jobId: opts?.jobId, fileName }, false).approvedBy;
    });
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.length);
    const total = packetCount(bytes.length);

    return this.run("upload", meta, true, async (s, r) => {
      r.data = { fileName, bytes: bytes.length, packets: total };
      const before = await this.statusIn(s);
      r.status = before;
      if (before.machine !== STATUS_READY) throw new Error(`printer is ${describe(before)}; uploads are only allowed when READY`);
      const existing = await this.listIn(s);
      if (!opts.overwrite && existing.some((f) => f.name === fileName)) throw new Error(`${fileName} already exists on the printer`);

      r.sent = true;
      const m28 = await s.command(`M28 ${bytes.length} 0:/user/${fileName}`);
      r.reply = m28;
      if (!isAcknowledged(m28, "M28", fileName) || !/Writing to file/i.test(m28)) throw new Error(`printer did not accept the upload: ${cleanReply(m28)}`);

      s.inDataMode = true;
      for (let i = 0; i < total; i++) {
        const chunk = bytes.subarray(i * PACKET_DATA_SIZE, (i + 1) * PACKET_DATA_SIZE);
        await s.write(buildPacket(i, chunk));
        if (this.o.packetDelayMs > 0) await sleep(this.o.packetDelayMs);
        const pending = cleanReply(s.pendingText());
        if (REPLY_ERROR.test(pending)) throw new Error(`printer reported an error during upload (packet ${i}): ${pending}`);
        const sent = Math.min((i + 1) * PACKET_DATA_SIZE, bytes.length);
        opts.onProgress?.({ bytesSent: sent, totalBytes: bytes.length, packetsSent: i + 1, totalPackets: total, percent: Math.floor((sent * 100) / bytes.length) });
      }
      s.inDataMode = false;
      await sleep(Math.max(this.o.packetDelayMs, 20));
      const late = cleanReply(s.pendingText());
      if (REPLY_ERROR.test(late)) throw new Error(`printer reported an error during upload: ${late}`);

      const m29 = await s.command("M29", this.o.uploadFinishTimeoutMs);
      r.reply = m28 + m29;
      if (!isAcknowledged(m29, "M29", fileName)) throw new Error(`printer did not finish the upload: ${cleanReply(m29)}`);
      r.acknowledged = true;

      const after = await this.listIn(s);
      r.status = await this.statusIn(s);
      r.confirmed = after.some((f) => f.name === fileName);
      if (!r.confirmed) r.error = `upload acknowledged but ${fileName} is not in the printer's file list`;
    });
  }

  /** Starts a file already on the printer (M23). Consumes the authorization. Confirmed on BUILDING_FROM_SD + matching CurrentFile. */
  async startPrint(opts: { jobId: string; fileName: string; authorization: PrintAuthorization | undefined }): Promise<ControlResult> {
    const meta: OpMeta = { jobId: opts?.jobId, fileName: opts?.fileName };
    this.assertEnabled("start", meta);
    const fileName = opts.fileName;
    this.guard("start", meta, () => {
      assertStoredFileName(fileName, { allowPlainGcode: this.o.allowPlainGcode });
      meta.approvedBy = this.authorizer.verify(opts.authorization, { jobId: opts.jobId, fileName }, false).approvedBy;
    });

    return this.run("start", meta, true, async (s, r) => {
      const before = await this.statusIn(s);
      r.status = before;
      if (before.machine !== STATUS_READY) throw new Error(`printer is ${describe(before)}; a print can only start from READY`);
      const files = await this.listIn(s);
      if (!files.some((f) => f.name === fileName)) throw new Error(`${fileName} is not stored on the printer`);
      // Consume right before sending, so a busy printer or missing file doesn't burn the approval.
      this.authorizer.verify(opts.authorization, { jobId: opts.jobId, fileName }, true);

      r.sent = true;
      r.reply = await s.command(`M23 0:/user/${fileName}`, this.o.startReplyTimeoutMs);
      r.acknowledged = isAcknowledged(r.reply, "M23", fileName);
      if (!r.acknowledged) throw new Error(`printer did not accept M23: ${cleanReply(r.reply)}`);
      await this.confirm(s, r, (st) => st.machine === STATUS_BUILDING && fileMatches(st.currentFile, fileName), this.o.startConfirmTimeoutMs, `${STATUS_BUILDING} with ${fileName}`);
    });
  }

  /** M25. No token needed; always logged. UNVERIFIED on hardware: confirmed only on one of `pausedStatuses`. */
  async pause(opts: { requestedBy: RequestedBy; reason?: string }): Promise<ControlResult> {
    const meta: OpMeta = { requestedBy: opts?.requestedBy, reason: opts?.reason };
    this.assertEnabled("pause", meta);
    return this.run("pause", meta, false, async (s, r) => {
      const before = await this.statusIn(s);
      r.status = before;
      meta.fileName = before.currentFile;
      if (before.machine !== STATUS_BUILDING) throw new Error(`printer is ${describe(before)}; nothing to pause`);
      r.sent = true;
      r.reply = await s.command("M25");
      r.acknowledged = isAcknowledged(r.reply, "M25");
      if (!r.acknowledged) throw new Error(`printer did not accept M25: ${cleanReply(r.reply)}`);
      await this.confirm(s, r, (st) => this.o.pausedStatuses.includes(st.machine ?? ""), this.o.confirmTimeoutMs, `one of ${this.o.pausedStatuses.join("/")}`);
    });
  }

  /** M24. Needs a fresh authorization for the paused job's file (consumed). UNVERIFIED on hardware. */
  async resume(opts: { jobId: string; fileName: string; authorization: PrintAuthorization | undefined }): Promise<ControlResult> {
    const meta: OpMeta = { jobId: opts?.jobId, fileName: opts?.fileName };
    this.assertEnabled("resume", meta);
    const fileName = opts.fileName;
    this.guard("resume", meta, () => {
      assertStoredFileName(fileName, { allowPlainGcode: this.o.allowPlainGcode });
      meta.approvedBy = this.authorizer.verify(opts.authorization, { jobId: opts.jobId, fileName }, false).approvedBy;
    });
    return this.run("resume", meta, false, async (s, r) => {
      const before = await this.statusIn(s);
      r.status = before;
      if (!this.o.pausedStatuses.includes(before.machine ?? "")) throw new Error(`printer is ${describe(before)}; nothing to resume`);
      if (before.currentFile && !fileMatches(before.currentFile, fileName)) {
        throw new Error(`paused file is ${before.currentFile}, not ${fileName}`);
      }
      this.authorizer.verify(opts.authorization, { jobId: opts.jobId, fileName }, true);
      r.sent = true;
      r.reply = await s.command("M24");
      r.acknowledged = isAcknowledged(r.reply, "M24");
      if (!r.acknowledged) throw new Error(`printer did not accept M24: ${cleanReply(r.reply)}`);
      await this.confirm(s, r, (st) => st.machine === STATUS_BUILDING, this.o.confirmTimeoutMs, STATUS_BUILDING);
    });
  }

  /** M26. No token needed; always logged; sent whatever the current state. Confirmed on READY. */
  async cancel(opts: { requestedBy: RequestedBy; reason?: string }): Promise<ControlResult> {
    const meta: OpMeta = { requestedBy: opts?.requestedBy, reason: opts?.reason };
    this.assertEnabled("cancel", meta);
    return this.run("cancel", meta, true, async (s, r) => {
      try {
        r.status = await this.statusIn(s);
        meta.fileName = r.status.currentFile;
      } catch {
        // a failed status read must not stop a cancel
      }
      r.sent = true;
      r.reply = await s.command("M26");
      r.acknowledged = isAcknowledged(r.reply, "M26");
      if (!r.acknowledged) throw new Error(`printer did not accept M26: ${cleanReply(r.reply)}`);
      await this.confirm(s, r, (st) => st.machine === STATUS_READY, this.o.confirmTimeoutMs, STATUS_READY);
    });
  }

  // ---- internals -------------------------------------------------------------

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async withSession<T>(fn: (s: ControlSession) => Promise<T>): Promise<T> {
    const s = await ControlSession.open(this.o.host, this.o.port, this.o.connectTimeoutMs, this.o.replyTimeoutMs);
    try {
      return await fn(s);
    } finally {
      await s.release();
    }
  }

  private async statusIn(s: ControlSession): Promise<PrinterStatus> {
    const m119 = cleanReply(await s.command("M119"));
    const m27 = cleanReply(await s.command("M27"));
    return parseStatus({ M119: m119, M27: m27 });
  }

  private async listIn(s: ControlSession): Promise<StoredFile[]> {
    const raw = await s.commandBinary("M661", (b) => {
      const p = parseFileList(b);
      return p.complete ? p.end : -1;
    });
    return parseFileList(raw).paths.map((path) => ({ path, name: baseName(path) }));
  }

  private async confirm(s: ControlSession, r: ControlResult<unknown>, ok: (st: PrinterStatus) => boolean, timeoutMs: number, expected: string) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const st = await this.statusIn(s);
      r.status = st;
      if (ok(st)) {
        r.confirmed = true;
        return;
      }
      if (Date.now() >= deadline) {
        r.error = `printer acknowledged but status did not become ${expected} within ${timeoutMs}ms (last: ${describe(st)})`;
        return;
      }
      await sleep(this.o.pollIntervalMs);
    }
  }

  private run<T>(
    op: ControlOp,
    meta: OpMeta,
    protocolVerified: boolean,
    body: (s: ControlSession, r: ControlResult<T>) => Promise<void>,
  ): Promise<ControlResult<T>> {
    return this.exclusive(async () => {
      const r: ControlResult<T> = { op, sent: false, acknowledged: false, confirmed: false, protocolVerified };
      try {
        await this.withSession((s) => body(s, r));
      } catch (e) {
        r.confirmed = false;
        r.error = (e as Error).message;
      }
      this.emitLog(op, meta, r);
      return r;
    });
  }

  private emitLog(op: ControlOp, meta: OpMeta, r: Pick<ControlResult<unknown>, "sent" | "acknowledged" | "confirmed" | "error" | "status">, rejected = false) {
    const outcome: ControlLogEntry["outcome"] = rejected ? "rejected" : r.confirmed ? "confirmed" : r.acknowledged ? "unconfirmed" : "failed";
    try {
      this.logFn({
        at: new Date().toISOString(),
        op,
        outcome,
        ...meta,
        sent: r.sent,
        acknowledged: r.acknowledged,
        confirmed: r.confirmed,
        error: r.error,
        status: r.status ? describe(r.status) : undefined,
      });
    } catch {
      // logging must never break printer control
    }
  }

  /** Runs a pre-flight check; on failure logs a "rejected" entry and rethrows. Nothing is sent. */
  private guard<T>(op: ControlOp, meta: OpMeta, check: () => T): T {
    try {
      return check();
    } catch (e) {
      this.emitLog(op, meta, { sent: false, acknowledged: false, confirmed: false, error: (e as Error).message }, true);
      throw e;
    }
  }

  private assertEnabled(op: ControlOp, meta: OpMeta) {
    if (this.enabled !== true) {
      this.guard(op, meta, () => {
        throw new ControllerDisabledError(`printer control is disabled (${op} refused)`);
      });
    }
  }
}
