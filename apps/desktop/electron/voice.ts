// Gemini Live voice session + tool handling. Gemini can only REQUEST actions;
// each tool call is checked here against app state and the user's own words.
import { randomUUID } from "node:crypto";
import { IPC, type AssistantTurn, type VoiceEvent } from "@morphix/shared";
import {
  GeminiLive, MORPHIX_SYSTEM_INSTRUCTION, MORPHIX_TOOLS, isAffirmative, speechStats, toMillimetres, type FunctionCall,
} from "@morphix/gemini";
import { MM_PER_INCH } from "@morphix/domain";
import { scaledCheck, stlSize } from "@morphix/slicing";
import { type Ctx, latestVersion, moveProject, now } from "./context";
import { type Actions, PolicyError } from "./actions";
import type { Printing } from "./printing";
import { formatDuration } from "./printing";

interface Turn {
  user: string;
  assistant: string;
  audioRel: string | null;
  /** App-generated event turn (not spoken by the user). */
  system: boolean;
}

export class VoiceController {
  private live: GeminiLive | null = null;
  private turn: Turn | null = null;
  private balance: { value: number; at: number } | null = null;

  constructor(
    private ctx: Ctx,
    private actions: Actions,
    private opts: { apiKey: string | undefined; model: string; meshyBalance: () => Promise<number | null>; printing: () => Printing | null },
  ) {
    if (opts.apiKey) {
      this.live = new GeminiLive(opts.apiKey, opts.model, MORPHIX_SYSTEM_INSTRUCTION, MORPHIX_TOOLS, {
        onAudio: (pcm) => {
          this.emit({ type: "status", state: "speaking" });
          const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
          this.emit({ type: "audio", pcm: ab as ArrayBuffer, sampleRate: 24000 });
        },
        onUserText: (t) => {
          if (this.turn && !this.turn.system) {
            this.turn.user += t;
            this.emit({ type: "user-text", text: this.turn.user });
          }
        },
        onAssistantText: (t) => {
          if (!this.turn) this.turn = { user: "", assistant: "", audioRel: null, system: true };
          this.turn.assistant += t;
          this.emit({ type: "assistant-text", text: this.turn.assistant });
        },
        onInterrupted: () => this.emit({ type: "interrupted" }),
        onTurnComplete: () => this.finishTurn(),
        onToolCall: (calls) => void this.handleTools(calls),
        onClose: (reason) => {
          this.ctx.log.write("info", "Gemini session closed", { reason });
          this.emit({ type: "status", state: "idle" });
        },
      });
    }
  }

  get enabled(): boolean {
    return this.live !== null;
  }

  private emit(e: VoiceEvent): void {
    this.ctx.send(IPC.voiceEvent, e);
  }

  private async connect(): Promise<GeminiLive> {
    if (!this.live) throw new Error("Gemini is not configured. Add GEMINI_API_KEY to ~/Morphix/config/morphix.env and restart Morphix.");
    if (!this.live.connected) this.emit({ type: "status", state: "connecting" });
    await this.live.ensureConnected();
    return this.live;
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.connect();
      this.emit({ type: "status", state: "idle" });
      return { ok: true, message: `Connected to ${this.opts.model}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /** One push-to-talk utterance (16 kHz PCM16). */
  async utterance(pcm: Buffer, audioRel: string | null): Promise<void> {
    const { rms, peak, seconds } = speechStats(pcm, 16000);
    if (seconds < 0.4 || (rms < 0.006 && peak < 0.04)) {
      this.emit({ type: "error", message: "I didn't catch that. Hold the button and speak a little closer to the mic." });
      return;
    }
    const live = await this.connect();
    this.turn = { user: "", assistant: "", audioRel, system: false };
    this.emit({ type: "status", state: "thinking" });
    live.sendUtterance(pcm);
  }

  async text(text: string): Promise<void> {
    const t = text.trim().slice(0, 500);
    if (!t) return;
    const live = await this.connect();
    this.turn = { user: t, assistant: "", audioRel: null, system: false };
    this.emit({ type: "user-text", text: t });
    this.emit({ type: "status", state: "thinking" });
    live.sendText(t);
  }

  /** Tell Gemini about something the app did (it reacts out loud). */
  async notify(message: string): Promise<void> {
    if (!this.live?.connected) return;
    this.turn = { user: "", assistant: "", audioRel: null, system: true };
    try {
      this.live.sendText(`[Morphix event] ${message}`);
    } catch (e) {
      this.ctx.log.write("warn", "notify failed", { error: (e as Error).message });
    }
  }

  private finishTurn(): void {
    const turn = this.turn;
    this.turn = null;
    this.emit({ type: "status", state: "idle" });
    if (!turn) return;
    const save = (role: "user" | "assistant", text: string, audioRel: string | null): AssistantTurn | null => {
      if (!text.trim()) return null;
      const row = { id: randomUUID(), role, text: text.trim(), createdAt: now() };
      this.ctx.db.run("INSERT INTO conversation(id, role, text, audio_rel_path, created_at) VALUES (?,?,?,?,?)", [
        row.id, role, row.text, audioRel, row.createdAt,
      ]);
      return { ...row, audioUrl: this.ctx.url(audioRel) ?? undefined };
    };
    const user = turn.system ? null : save("user", turn.user || "(voice message)", turn.audioRel);
    const assistant = save("assistant", turn.assistant, null);
    this.emit({ type: "turn-complete", user, assistant });
  }

  // ---------------------------------------------------------------------
  // Tool policy

  private async handleTools(calls: FunctionCall[]): Promise<void> {
    const responses = [];
    for (const c of calls) {
      let response: Record<string, unknown>;
      try {
        response = await this.tool(c);
      } catch (e) {
        response = { ok: false, error: (e as Error).message };
      }
      this.ctx.log.write("info", `tool ${c.name}`, { args: c.args, ok: response.ok !== false });
      responses.push({ id: c.id, name: c.name, response });
    }
    try {
      this.live?.sendToolResponses(responses);
    } catch (e) {
      this.ctx.log.write("error", "tool response failed", { error: (e as Error).message });
    }
  }

  private async credits(): Promise<number | null> {
    if (this.balance && Date.now() - this.balance.at < 60_000) return this.balance.value;
    const v = await this.opts.meshyBalance().catch(() => null);
    if (v !== null) this.balance = { value: v, at: Date.now() };
    return v;
  }

  private async tool(c: FunctionCall): Promise<Record<string, unknown>> {
    const a = c.args;
    switch (c.name) {
      case "generate_model": {
        const p = this.actions.proposeGenerate(String(a.prompt ?? ""), String(a.title ?? ""));
        return { ok: true, status: "awaiting_user_confirmation", credits: p.credits, balance: await this.credits(), note: "Ask the user to say yes or tap Confirm." };
      }
      case "revise_model": {
        const pid = this.ctx.currentProjectId;
        if (!pid) throw new PolicyError("there is no current model to revise");
        const title = String(this.ctx.db.get("SELECT title FROM projects WHERE id = ?", [pid])?.title ?? "model");
        const p = this.actions.proposeGenerate(String(a.prompt ?? ""), title, pid);
        return { ok: true, status: "awaiting_user_confirmation", credits: p.credits, balance: await this.credits() };
      }
      case "refine_current_model": {
        const p = this.actions.proposeRefine(null);
        return { ok: true, status: "awaiting_user_confirmation", credits: p.credits, balance: await this.credits() };
      }
      case "confirm_pending_action": {
        const pending = this.actions.current;
        if (!pending) return { ok: false, error: "nothing is waiting for confirmation" };
        const words = this.turn?.user ?? "";
        if (this.turn?.system || !isAffirmative(words)) {
          return { ok: false, error: "The user has not clearly said yes. Ask them to say yes or tap Confirm on the screen." };
        }
        const r = this.actions.confirm(pending.id, "voice");
        if (r.printing) {
          r.printing.then(
            () => void this.notify("The printer confirmed the print has started. Tell the user briefly; the camera guardian is watching it."),
            (e) => void this.notify(`Starting the print failed: ${(e as Error).message}. Tell the user plainly.`),
          );
          return { ok: true, status: "sending_to_printer", note: "Not printing yet: wait for the [Morphix event] that the printer confirmed." };
        }
        return { ok: true, status: "started", kind: pending.kind, credits: pending.credits, projectId: r.projectId, note: "Generation takes about one to three minutes." };
      }
      case "cancel_pending_action": {
        this.actions.clear();
        return { ok: true, status: "cancelled" };
      }
      case "set_model_height": {
        const mm = toMillimetres(Number(a.value), String(a.unit ?? "mm"));
        if (!(mm >= 5 && mm <= 600)) throw new PolicyError("height must be between 5 mm and 600 mm");
        const v = latestVersion(this.ctx, this.ctx.currentProjectId);
        if (!v) throw new PolicyError("there is no current model");
        this.ctx.db.run("UPDATE model_versions SET target_height_mm = ? WHERE id = ?", [Math.round(mm * 10) / 10, v.id]);
        try {
          moveProject(this.ctx, String(v.project_id), "sizing");
        } catch {
          /* keep current state */
        }
        this.ctx.event({ type: "navigate", page: "viewer", projectId: String(v.project_id) });
        this.ctx.event({ type: "model-height", versionId: String(v.id), heightMm: mm });
        const size = this.sizeOf(String(v.stl_rel_path ?? ""), mm);
        return {
          ok: true, heightMm: Math.round(mm), heightInches: Math.round((mm / MM_PER_INCH) * 10) / 10,
          ...(size ? { widthMm: Math.round(size.size.x), depthMm: Math.round(size.size.y), fitsPrinter: size.fits, buildVolumeMm: size.volume } : {}),
        };
      }
      case "get_app_state": {
        const pid = this.ctx.currentProjectId;
        const project = pid ? this.ctx.db.get("SELECT title, state FROM projects WHERE id = ?", [pid]) : undefined;
        const v = latestVersion(this.ctx, pid);
        const target = v?.target_height_mm == null ? null : Number(v.target_height_mm);
        const size = v ? this.sizeOf(String(v.stl_rel_path ?? ""), target) : null;
        return {
          ok: true,
          project: project ? { title: project.title, state: project.state, modelKind: v?.kind ?? null } : null,
          targetHeightMm: target,
          fitsPrinter: size?.fits ?? null,
          pendingAction: this.actions.current ? { kind: this.actions.current.kind, credits: this.actions.current.credits } : null,
          meshyCredits: await this.credits(),
          print: (() => {
            const printing = this.opts.printing();
            if (!printing) return null;
            const st = printing.status();
            const job = pid ? printing.latest(pid) : null;
            return { controlsEnabled: st.enabled, gxVerified: st.gxVerified, activeJob: st.job, prepared: job ? { ok: job.ok, fits: job.fits, estimates: job.estimates } : null };
          })(),
        };
      }
      case "prepare_print": {
        const printing = this.opts.printing();
        const v = latestVersion(this.ctx, this.ctx.currentProjectId);
        if (!printing || !v) throw new PolicyError("there is no current model to prepare");
        const layer = a.quality === "draft" ? 0.28 : a.quality === "fine" ? 0.12 : 0.2;
        const infill = Math.min(60, Math.max(5, Number(a.infill_percent ?? 15)));
        const supports = ["none", "auto", "buildplate"].includes(String(a.supports)) ? (String(a.supports) as "none" | "auto" | "buildplate") : "auto";
        this.ctx.event({ type: "navigate", page: "prepare", projectId: String(v.project_id) });
        const r = await printing.prepare(String(v.id), { layerHeightMm: layer, infillPercent: infill, supports });
        return {
          ok: r.ok, jobId: r.jobId, fits: r.fits, sizeMm: r.size ? [Math.round(r.size.x), Math.round(r.size.y), Math.round(r.size.z)] : null,
          printTime: r.estimates?.printTimeS ? formatDuration(r.estimates.printTimeS) : null,
          filamentGrams: r.estimates?.filamentG ? Math.round(r.estimates.filamentG) : null,
          estimateSource: r.estimates?.source, slicer: r.slicer.ok ? "ok" : r.slicer.message, warnings: r.warnings.slice(0, 3), error: r.error,
        };
      }
      case "request_print": {
        const printing = this.opts.printing();
        const pid = this.ctx.currentProjectId;
        const job = printing && pid ? printing.latest(pid) : null;
        if (!job) return { ok: false, message: "Prepare the model first (prepare_print)." };
        const p = this.actions.proposePrint(job.jobId);
        return { ok: true, status: "awaiting_user_confirmation", file: p.fileName, details: p.details, note: "Ask the user to tap Confirm or say yes." };
      }
      case "printer_light":
      case "printer_fan":
      case "home_printer":
      case "set_temperature":
      case "cool_down":
      case "stop_printer": {
        const printing = this.opts.printing();
        if (!printing) throw new PolicyError("printing is not available");
        if (c.name === "stop_printer" && (this.turn?.system || !/\b(stop|cancel|abort|emergency)\b/i.test(this.turn?.user ?? ""))) {
          return { ok: false, message: "Only stop when the user clearly asks to stop." };
        }
        if (c.name === "set_temperature" && this.turn?.system) return { ok: false, message: "Only heat when the user asks." };
        const cmd =
          c.name === "printer_light" ? { cmd: "light" as const, on: Boolean(a.on) }
          : c.name === "printer_fan" ? { cmd: "fan" as const, percent: Number(a.percent ?? 100) }
          : c.name === "home_printer" ? { cmd: "home" as const }
          : c.name === "cool_down" ? { cmd: "cooldown" as const }
          : c.name === "stop_printer" ? { cmd: "stop" as const }
          : { cmd: (a.heater === "bed" ? "bed" : "nozzle") as "bed" | "nozzle", celsius: Number(a.celsius) };
        return await printing.machine(cmd, "voice");
      }
      case "pause_print": {
        const printing = this.opts.printing();
        if (!printing) throw new PolicyError("printing is not available");
        return await printing.pause();
      }
      case "cancel_print": {
        const printing = this.opts.printing();
        if (!printing) throw new PolicyError("printing is not available");
        if (this.turn?.system || !/\b(cancel|stop|abort)\b/i.test(this.turn?.user ?? "")) {
          return { ok: false, message: "Only cancel when the user clearly asks to cancel or stop the print." };
        }
        return await printing.cancel();
      }
      default:
        return { ok: false, error: `unknown tool ${c.name}` };
    }
  }

  private sizeOf(stlRel: string, targetMm: number | null) {
    if (!stlRel) return null;
    try {
      const native = stlSize(this.ctx.storage.read(this.ctx.storage.path(stlRel)));
      return native ? scaledCheck(native, targetMm) : null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.live?.close();
  }
}
