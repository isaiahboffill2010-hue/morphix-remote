// QD330 adapter — OBSERVATION ONLY (Phase 1).
// Talks to TCP 8899 ("~CMD\r\n" ... "ok"). Only the read-only commands in
// READ_ONLY_COMMANDS can be sent; everything else is rejected before it reaches
// the socket. Motion, temperature, upload and job commands arrive in Phase 5
// after each has been validated with the operator present.
import { Socket } from "node:net";
import type { PrinterInfo, PrinterStatus } from "@morphix/shared";

export const READ_ONLY_COMMANDS = new Set([
  "M601 S1", // take the session (required before queries; no physical effect)
  "M602", // release the session
  "M115", // machine info
  "M119", // machine status / endstops
  "M105", // temperatures
  "M114", // position
  "M27", // job progress
]);

export class PrinterCommandRejected extends Error {}

export function assertReadOnly(cmd: string): void {
  if (!READ_ONLY_COMMANDS.has(cmd.trim())) {
    throw new PrinterCommandRejected(`command not allowed in observation mode: ${cmd}`);
  }
}

export interface PrinterTransport {
  query(cmds: string[]): Promise<Record<string, string>>;
}

/** Raw TCP transport. Opens a session per query batch and always releases it. */
export class TcpTransport implements PrinterTransport {
  constructor(private host: string, private port = 8899, private timeoutMs = 4000) {}

  query(cmds: string[]): Promise<Record<string, string>> {
    try {
      cmds.forEach(assertReadOnly);
    } catch (e) {
      return Promise.reject(e);
    }
    const all = ["M601 S1", ...cmds, "M602"];
    return new Promise((resolvePromise, reject) => {
      const sock = new Socket();
      const out: Record<string, string> = {};
      let i = 0;
      let buf = "";
      const timer = setTimeout(() => fail(new Error(`printer timeout at ${all[i]}`)), this.timeoutMs * all.length);
      const fail = (e: Error) => {
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      };
      const sendNext = () => {
        if (i >= all.length) {
          clearTimeout(timer);
          sock.end();
          resolvePromise(out);
          return;
        }
        sock.write(`~${all[i]}\r\n`);
      };
      sock.setEncoding("latin1");
      sock.on("data", (d: string) => {
        buf += d;
        if (/(^|\n)ok\s*$/.test(buf.replace(/\r/g, ""))) {
          out[all[i]] = cleanReply(buf);
          buf = "";
          i++;
          sendNext();
        }
      });
      sock.on("error", (e) => fail(new Error(`cannot reach printer at ${this.host}:${this.port}: ${e.message}`)));
      sock.connect(this.port, this.host, sendNext);
    });
  }
}

export function cleanReply(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("CMD ") && l.trim() !== "ok")
    .join("\n");
}

function kv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

export function parseStatus(r: Record<string, string>): PrinterStatus {
  const st = kv(r["M119"] ?? "");
  const temps: PrinterStatus["temps"] = {};
  for (const m of (r["M105"] ?? "").matchAll(/(T0|B):\s*([\d.]+)\s*\/\s*([\d.]+)/g)) {
    temps[m[1] === "T0" ? "nozzle" : "bed"] = { current: Number(m[2]), target: Number(m[3]) };
  }
  const position: Record<string, number> = {};
  for (const m of (r["M114"] ?? "").matchAll(/([XYZ]):\s*(-?[\d.]+)/g)) position[m[1].toLowerCase()] = Number(m[2]);
  const prog = /byte\s+(\d+)\s*\/\s*(\d+)/.exec(r["M27"] ?? "");
  const layer = /Layer:\s*(\d+)\s*\/\s*(\d+)/.exec(r["M27"] ?? "");
  return {
    online: true,
    checkedAt: new Date().toISOString(),
    machine: st["MachineStatus"],
    moveMode: st["MoveMode"],
    currentFile: st["CurrentFile"] || undefined,
    temps,
    position,
    progress: prog ? Math.floor((Number(prog[1]) * 100) / Math.max(Number(prog[2]), 1)) : 0,
    layer: layer ? [Number(layer[1]), Number(layer[2])] : [0, 0],
  };
}

export function parseInfo(text: string): PrinterInfo {
  const k = kv(text);
  return {
    machineType: k["Machine Type"],
    machineName: k["Machine Name"],
    firmware: k["Firmware"],
    serial: k["SN"],
    buildVolume: k["X"] ? `X: ${k["X"]}` : undefined,
  };
}

/** Polls the printer and reports status changes. Never sends control commands. */
export class PrinterObserver {
  private timer: NodeJS.Timeout | null = null;
  private last: PrinterStatus = { online: false, checkedAt: new Date(0).toISOString(), error: "not checked yet" };

  constructor(
    private transport: PrinterTransport,
    private onStatus: (s: PrinterStatus, previous: PrinterStatus) => void,
  ) {}

  get status(): PrinterStatus {
    return this.last;
  }

  async poll(): Promise<PrinterStatus> {
    const previous = this.last;
    try {
      this.last = parseStatus(await this.transport.query(["M119", "M105", "M114", "M27"]));
    } catch (e) {
      this.last = { online: false, checkedAt: new Date().toISOString(), error: (e as Error).message };
    }
    this.onStatus(this.last, previous);
    return this.last;
  }

  async info(): Promise<PrinterInfo> {
    const r = await this.transport.query(["M115"]);
    return parseInfo(r["M115"] ?? "");
  }

  start(intervalMs: number): void {
    this.stop();
    const tick = async () => {
      await this.poll();
      this.timer = setTimeout(tick, intervalMs);
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
