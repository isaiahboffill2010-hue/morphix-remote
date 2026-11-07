// A fake Afinia QD330 on 127.0.0.1 for tests and demos. Reproduces the reply
// formats recorded from the real printer (firmware v2.1.3): "CMD X Received."
// … "ok", the binary M661 list, M28 packet framing with CRC checks, and the
// M23/M25/M24/M26 state changes. It can also misbehave on purpose.
// Strings marked UNVERIFIED are guesses; the real printer may differ.
import { createServer, type Server, type Socket } from "node:net";
import {
  crc32,
  encodeFileList,
  PACKET_DATA_SIZE,
  PACKET_HEADER_SIZE,
  PACKET_MAGIC,
  packetCount,
} from "./protocol";

export interface FakeQD330Failures {
  /** M601 S1 answers "Control failed." */
  refuseControl?: boolean;
  /** Verbs (e.g. "M23") that are received but never answered. */
  silent?: string[];
  /** Verbs on which the fake drops the connection instead of answering. */
  dropOn?: string[];
  /** Packet index whose CRC is treated as wrong. */
  corruptPacket?: number;
  /** Drop the connection when this packet index arrives. */
  dropOnPacket?: number;
  /** M28 answers with an error. */
  rejectUpload?: boolean;
  /** M29 succeeds but the file is not stored (so it never appears in M661). */
  loseUploadedFile?: boolean;
  /** Commands are acknowledged but the machine status never changes. */
  ignoreStart?: boolean;
  ignorePause?: boolean;
  ignoreResume?: boolean;
  ignoreCancel?: boolean;
}

export interface FakeQD330Options {
  /** Files already on the printer: name -> contents. */
  files?: Record<string, Uint8Array>;
  /** MachineStatus after M25. UNVERIFIED on hardware; default "PAUSED". */
  pausedStatus?: string;
  /** Delay before M23/M25/M24/M26 change the status. Default 0. */
  stateChangeDelayMs?: number;
  /** Send "ok" after the binary M661 payload. Default true. */
  m661Ok?: boolean;
  failures?: FakeQD330Failures;
}

interface Upload {
  name: string;
  size: number;
  total: number;
  next: number;
  chunks: Buffer[];
  error?: string;
}

interface Conn {
  sock: Socket;
  buf: Buffer;
  upload: Upload | null;
}

export class FakeQD330 {
  machineStatus = "READY";
  moveMode = "READY";
  currentFile = "";
  /** M27 "SD printing byte N/100". */
  progress = 0;
  layer: [number, number] = [0, 0];
  readonly files = new Map<string, Buffer>();
  failures: FakeQD330Failures;
  /** Every command received, in order, without the "~" prefix. */
  readonly received: string[] = [];
  /** Upload outcomes as seen by the fake. */
  readonly uploads: { name: string; ok: boolean; error?: string }[] = [];
  /** Times M601 was refused because another connection held control (should stay 0 for Morphix). */
  controlConflicts = 0;

  private server: Server | null = null;
  private socks = new Set<Socket>();
  private controlHolder: Socket | null = null;
  private pausedStatus: string;
  private delayMs: number;
  private m661Ok: boolean;
  private pending = new Set<NodeJS.Timeout>();

  constructor(opts: FakeQD330Options = {}) {
    for (const [k, v] of Object.entries(opts.files ?? {})) this.files.set(k, Buffer.from(v));
    this.pausedStatus = opts.pausedStatus ?? "PAUSED";
    this.delayMs = opts.stateChangeDelayMs ?? 0;
    this.m661Ok = opts.m661Ok ?? true;
    this.failures = opts.failures ?? {};
  }

  /** Listens on 127.0.0.1 only. Returns the port. */
  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((sock) => this.accept(sock));
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        resolve(this.port);
      });
    });
  }

  get port(): number {
    const a = this.server?.address();
    return a && typeof a === "object" ? a.port : 0;
  }

  close(): Promise<void> {
    for (const t of this.pending) clearTimeout(t);
    for (const s of this.socks) s.destroy();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Test helper: move an active print along. */
  setProgress(percent: number, layer?: [number, number]): void {
    this.progress = percent;
    if (layer) this.layer = layer;
  }

  /** Test helper: the print finishes normally. */
  finishPrint(): void {
    this.progress = 100;
    this.layer = [this.layer[1], this.layer[1]];
    this.machineStatus = "READY";
  }

  /** Test helper: the print stops on its own (e.g. a printer-side fault or someone cancels at the printer). */
  abortPrint(): void {
    this.machineStatus = "READY";
  }

  // ---- connection handling -------------------------------------------------------

  private accept(sock: Socket) {
    this.socks.add(sock);
    const conn: Conn = { sock, buf: Buffer.alloc(0), upload: null };
    sock.on("data", (d: Buffer) => {
      conn.buf = Buffer.concat([conn.buf, d]);
      this.process(conn);
    });
    const done = () => {
      this.socks.delete(sock);
      if (this.controlHolder === sock) this.controlHolder = null;
    };
    sock.on("close", done);
    sock.on("error", done);
  }

  private process(c: Conn) {
    for (;;) {
      if (c.sock.destroyed) return;
      if (c.upload && c.upload.next < c.upload.total) {
        const n = PACKET_HEADER_SIZE + PACKET_DATA_SIZE;
        if (c.buf.length < n) return;
        const pkt = c.buf.subarray(0, n);
        c.buf = c.buf.subarray(n);
        this.packet(c, pkt);
        continue;
      }
      const nl = c.buf.indexOf("\n");
      if (nl < 0) return;
      const line = c.buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      c.buf = c.buf.subarray(nl + 1);
      if (line.startsWith("~")) this.command(c, line.slice(1));
    }
  }

  private send(c: Conn, data: string | Buffer) {
    if (!c.sock.destroyed) c.sock.write(data);
  }

  private reply(c: Conn, verb: string, lines: string[] = []) {
    this.send(c, `CMD ${verb} Received.\r\n${lines.map((l) => l + "\r\n").join("")}ok\r\n`);
  }

  private later(fn: () => void) {
    if (this.delayMs <= 0) return fn();
    const t = setTimeout(() => {
      this.pending.delete(t);
      fn();
    }, this.delayMs);
    this.pending.add(t);
  }

  private command(c: Conn, cmd: string) {
    this.received.push(cmd);
    const verb = cmd.split(/\s+/)[0].toUpperCase();
    const f = this.failures;
    if (f.dropOn?.includes(verb)) return void c.sock.destroy();
    if (f.silent?.includes(verb)) return;

    switch (verb) {
      case "M601": {
        if (this.controlHolder && this.controlHolder !== c.sock) {
          this.controlConflicts++;
          return this.reply(c, verb, ["Control failed."]); // UNVERIFIED wording
        }
        if (f.refuseControl) return this.reply(c, verb, ["Control failed."]);
        this.controlHolder = c.sock;
        return this.reply(c, verb, ["Control Success V2.1."]);
      }
      case "M602":
        if (this.controlHolder === c.sock) this.controlHolder = null;
        return this.reply(c, verb, ["Control Release."]);
      case "M115":
        return this.reply(c, verb, ["Machine Type: Afinia 3D QD330", "Machine Name: QD330", "Firmware: v2.1.3", "SN: SNFAKE0000001", "X: 220 Y: 220 Z: 220", "Tool Count: 1"]);
      case "M119":
        return this.reply(c, verb, [
          "Endstop: X-max: 110 Y-max: 110 Z-min: 0",
          `MachineStatus: ${this.machineStatus}`,
          `MoveMode: ${this.machineStatus === "BUILDING_FROM_SD" ? "MOVING" : this.moveMode}`,
          "Status: S:1 L:0 J:0 F:0",
          "LED: 1",
          `CurrentFile: ${this.currentFile}`,
        ]);
      case "M105":
        return this.reply(c, verb, ["T0:26.9/0.0 T1:0.0/0.0 B:24.4/0.0"]);
      case "M114":
        return this.reply(c, verb, ["X:110.037 Y:110.037 Z:220.000 A:0.000 B:0"]);
      case "M27":
        return this.reply(c, verb, [`SD printing byte ${this.progress}/100`, `Layer: ${this.layer[0]}/${this.layer[1]}`]);
      case "M661": {
        const list = encodeFileList([...this.files.keys()].map((n) => `/data/${n}`));
        this.send(c, Buffer.concat([Buffer.from(`CMD M661 Received.\r\n`), list, Buffer.from(this.m661Ok ? "\r\nok\r\n" : "")]));
        return;
      }
      case "M28": {
        const m = /^M28\s+(\d+)\s+0:\/user\/(.+)$/.exec(cmd);
        if (f.rejectUpload || !m) return this.reply(c, verb, ["Error: cannot open file for writing"]); // UNVERIFIED wording
        const size = Number(m[1]);
        c.upload = { name: m[2], size, total: packetCount(size), next: 0, chunks: [] };
        return this.reply(c, verb, [`Writing to file: /data/${m[2]}`]);
      }
      case "M29": {
        const u = c.upload;
        c.upload = null;
        if (!u) return this.reply(c, verb, ["Error: no file open"]);
        const data = Buffer.concat(u.chunks);
        const error = u.error ?? (data.length !== u.size ? `size mismatch ${data.length}/${u.size}` : undefined);
        this.uploads.push({ name: u.name, ok: !error, error });
        if (error) return this.reply(c, verb, [`Error: file transfer failed (${error})`]); // UNVERIFIED wording
        if (!f.loseUploadedFile) this.files.set(u.name, data);
        return this.reply(c, verb, ["Done saving file."]);
      }
      case "M23": {
        const name = cmd.replace(/^M23\s+/, "").replace(/^0:\/user\//, "");
        const file = this.files.get(name);
        if (!file) return this.reply(c, verb, [`Error: open failed, File: 0:/user/${name}`]); // UNVERIFIED wording
        if (this.machineStatus !== "READY") return this.reply(c, verb, ["Error: printer busy"]); // UNVERIFIED wording
        if (!f.ignoreStart) {
          this.later(() => {
            this.machineStatus = "BUILDING_FROM_SD";
            this.currentFile = name;
            this.progress = 0;
            this.layer = [0, 100];
          });
        }
        return this.reply(c, verb, [`File opened: ${name} Size: ${file.length}`, "File selected"]);
      }
      case "M25":
        if (this.machineStatus === "BUILDING_FROM_SD" && !f.ignorePause) this.later(() => (this.machineStatus = this.pausedStatus));
        return this.reply(c, verb);
      case "M24":
        if (this.machineStatus === this.pausedStatus && !f.ignoreResume) this.later(() => (this.machineStatus = "BUILDING_FROM_SD"));
        return this.reply(c, verb);
      case "M26":
        if (!f.ignoreCancel) {
          this.later(() => {
            this.machineStatus = "READY";
            this.currentFile = "";
            this.progress = 0;
            this.layer = [0, 0];
          });
        }
        return this.reply(c, verb);
      default:
        return this.reply(c, verb);
    }
  }

  private packet(c: Conn, pkt: Buffer) {
    const u = c.upload!;
    const idx = u.next++;
    if (this.failures.dropOnPacket === idx) return void c.sock.destroy();
    if (u.error) return;
    const magic = pkt.readUInt32BE(0);
    const index = pkt.readUInt32BE(4);
    const len = pkt.readUInt32BE(8);
    const crc = pkt.readUInt32BE(12);
    const expectLen = idx === u.total - 1 ? u.size - idx * PACKET_DATA_SIZE : PACKET_DATA_SIZE;
    const data = pkt.subarray(PACKET_HEADER_SIZE, PACKET_HEADER_SIZE + Math.min(len, PACKET_DATA_SIZE));
    let error: string | undefined;
    if (magic !== PACKET_MAGIC) error = `bad packet magic at packet ${idx}`;
    else if (index !== idx) error = `packet index ${index}, expected ${idx}`;
    else if (len !== expectLen) error = `packet ${idx} length ${len}, expected ${expectLen}`;
    else if (crc !== crc32(data) || this.failures.corruptPacket === idx) error = `CRC mismatch at packet ${idx}`;
    if (error) {
      u.error = error;
      this.send(c, `Error: ${error}\r\n`); // UNVERIFIED: the real printer's per-packet error reporting is unknown
      return;
    }
    u.chunks.push(Buffer.from(data));
  }
}
