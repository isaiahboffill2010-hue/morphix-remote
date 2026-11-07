import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AppSettings, AssistantTurn, PendingAction, PrinterStatus, VoiceEvent } from "@morphix/shared";
import { api } from "./bridge";
import { AudioOut, PushToTalk, alertChime } from "./audio";
import { installDragScroll } from "./dragScroll";
import { useTheme } from "./theme";
import { JobBar } from "./components/JobBar";
import { friendlyError, type FriendlyError } from "./errors";
import { AssistantPage } from "./pages/Assistant";
import { LibraryPage } from "./pages/Library";
import { ViewerPage } from "./pages/Viewer";
import { PrinterPage } from "./pages/Printer";
import { SettingsPage } from "./pages/Settings";
import { PreparePage } from "./pages/Prepare";

export type Page = "assistant" | "library" | "viewer" | "prepare" | "printer" | "settings";
type RailPage = Exclude<Page, "prepare">;
export type VoiceState = Extract<VoiceEvent, { type: "status" }>["state"] | "listening";

export interface Voice {
  live: boolean;
  state: VoiceState;
  level: number;
  turns: AssistantTurn[];
  userDraft: string;
  assistantDraft: string;
  setTurns: (fn: (t: AssistantTurn[]) => AssistantTurn[]) => void;
  startTalk: () => void;
  stopTalk: () => void;
  sendText: (text: string) => Promise<void>;
  proposal: string | null;
  setProposal: (p: string | null) => void;
}

type NavItem = Exclude<RailPage, "viewer">;
const EMOJI: Record<NavItem, string> = { assistant: "🎤", library: "🧸", printer: "🖨️", settings: "⚙️" };
const LABELS: Record<NavItem, string> = { assistant: "Make", library: "My Things", printer: "Printer", settings: "Grown-ups" };
const STATE_TEXT: Record<VoiceState, string> = {
  idle: "Hold the button and talk!", ready: "Hold the button and talk!", listening: "I'm listening… let go when you're done",
  connecting: "Waking up…", thinking: "Hmm, let me think…", speaking: "Talking… (hold to interrupt)", offline: "Hold the button and talk!",
};
export const voiceLabel = (s: VoiceState) => STATE_TEXT[s];

/** Keeps one failing page from blanking the whole kiosk. */
class PageBoundary extends Component<{ children: ReactNode; page: string }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  componentDidCatch(e: Error) {
    api.log("error", `page ${this.props.page} crashed: ${e.message}`);
  }
  componentDidUpdate(prev: { page: string }) {
    if (prev.page !== this.props.page && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty">
        <div>
          <div style={{ fontSize: 20, fontWeight: 650 }}>This screen hit a problem</div>
          <div className="muted small" style={{ margin: "6px 0 12px" }}>{this.state.error}</div>
          <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    );
  }
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3" />
    </svg>
  );
}

export function MicButton({ voice, big = false }: { voice: Voice; big?: boolean }) {
  const busy = voice.state === "thinking" || voice.state === "connecting";
  return (
    <button
      className={`${big ? "mic" : "mic-small"} ${voice.state === "listening" ? "live" : ""} ${busy ? "busy" : ""}`}
      style={{ ["--lvl" as string]: voice.level }}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        voice.startTalk();
      }}
      onPointerUp={voice.stopTalk}
      onPointerCancel={voice.stopTalk}
      aria-label="Hold to talk"
    >
      <MicIcon />
    </button>
  );
}

/** Settings are for grown-ups: hold for 2 seconds to open. */
function GrownUpButton({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const [pct, setPct] = useState(0);
  const timer = useRef<number | null>(null);
  const stop = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    setPct(0);
  };
  const start = () => {
    if (active) return onOpen();
    const t0 = Date.now();
    timer.current = window.setInterval(() => {
      const p = Math.min(100, ((Date.now() - t0) / 2000) * 100);
      setPct(p);
      if (p >= 100) {
        stop();
        onOpen();
      }
    }, 50);
  };
  return (
    <button className={`hold ${active ? "active" : ""}`} style={{ ["--hold" as string]: `${pct}%`, marginTop: "auto" }} onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}>
      <span className="emoji">{EMOJI.settings}</span>
      {pct > 0 ? "Keep holding…" : LABELS.settings}
    </button>
  );
}

export function App() {
  const [page, setPage] = useState<Page>("assistant");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [printer, setPrinter] = useState<PrinterStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [notice, setNotice] = useState<(FriendlyError & { level: string }) | null>(null);
  const [heightEvent, setHeightEvent] = useState<{ versionId: string; heightMm: number; n: number } | null>(null);

  // voice
  const [state, setState] = useState<VoiceState>("idle");
  const [level, setLevel] = useState(0);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [userDraft, setUserDraft] = useState("");
  const [assistantDraft, setAssistantDraft] = useState("");
  const [proposal, setProposal] = useState<string | null>(null);
  const ptt = useRef<PushToTalk | null>(null);
  const out = useRef(new AudioOut());
  const live = settings?.ai.assistant === "gemini-live";
  const theme = useTheme();

  const showNotice = useCallback((message: string, level = "error", code?: string, hint?: string) => {
    const f = code ? { code, title: message, hint } : friendlyError(message);
    if (level === "error") api.log("warn", `notice shown: ${f.code ?? ""} ${f.title}`);
    setNotice({ ...f, level });
    setTimeout(() => setNotice(null), 8000);
  }, []);

  useEffect(() => installDragScroll(), []);

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.printerStatus().then(setPrinter);
    api.pendingAction().then(setPending);
    api.conversation().then(setTurns);
    const offs = [
      api.onPrinterStatus(setPrinter),
      api.onAppEvent((e) => {
        if (e.type === "pending") setPending(e.action);
        else if (e.type === "navigate") {
          if (e.projectId) setProjectId(e.projectId);
          setPage(e.page);
        } else if (e.type === "model-height") setHeightEvent((h) => ({ versionId: e.versionId, heightMm: e.heightMm, n: (h?.n ?? 0) + 1 }));
        else if (e.type === "notice") showNotice(e.message, e.level, e.code, e.hint);
      }),
      api.onVoiceEvent((e) => {
        switch (e.type) {
          case "status":
            setState((s) => (s === "listening" ? s : e.state));
            break;
          case "user-text":
            setUserDraft(e.text);
            break;
          case "assistant-text":
            setAssistantDraft(e.text);
            break;
          case "audio":
            out.current.play(e.pcm, e.sampleRate);
            break;
          case "interrupted":
            out.current.stop();
            break;
          case "alert":
            out.current.stop();
            void alertChime();
            break;
          case "turn-complete":
            setTurns((t) => [...t, ...[e.user, e.assistant].filter((x): x is AssistantTurn => Boolean(x))]);
            setUserDraft("");
            setAssistantDraft("");
            break;
          case "error":
            showNotice(e.message);
            setState("idle");
            break;
        }
      }),
    ];
    // A new/removed speaker (USB unplugged) leaves the old audio output dead: start fresh.
    const onDevices = () => out.current.reset();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDevices);
    return () => {
      offs.forEach((off) => off());
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDevices);
    };
  }, [showNotice]);

  const startTalk = useCallback(async () => {
    if (ptt.current?.active) return;
    if (!live) {
      showNotice("Gemini isn't set up yet: add GEMINI_API_KEY to ~/Morphix/config/morphix.env and restart Morphix.");
      return;
    }
    out.current.stop(); // barge-in: stop Gemini speaking
    try {
      ptt.current = new PushToTalk(setLevel);
      await ptt.current.start();
      setState("listening");
    } catch (e) {
      showNotice(`Microphone unavailable: ${(e as Error).message}`);
    }
  }, [live, showNotice]);

  const stopTalk = useCallback(async () => {
    if (!ptt.current?.active) return;
    try {
      const { pcm, sampleRate, seconds } = await ptt.current.stop();
      if (seconds < 0.3) {
        setState("idle");
        return;
      }
      setState("thinking");
      await api.voiceTurn(pcm, sampleRate);
    } catch (e) {
      showNotice((e as Error).message);
      setState("idle");
    }
  }, [live, showNotice]);

  const sendText = useCallback(
    async (text: string) => {
      try {
        if (!live) throw new Error("Gemini isn't set up yet: add GEMINI_API_KEY to ~/Morphix/config/morphix.env and restart Morphix.");
        await api.voiceText(text);
      } catch (e) {
        showNotice((e as Error).message);
      }
    },
    [live, showNotice],
  );

  const voice: Voice = {
    live, state, level, turns, userDraft, assistantDraft, setTurns, proposal, setProposal,
    startTalk: () => void startTalk(), stopTalk: () => void stopTalk(), sendText,
  };

  const openProject = (id: string) => {
    setProjectId(id);
    setPage("viewer");
  };

  const pDot = !printer ? "" : printer.online ? (printer.machine === "READY" ? "ok" : "warn") : "bad";
  const pText = !printer ? "Printer…" : printer.online ? `QD330 · ${(printer.machine ?? "online").replaceAll("_", " ").toLowerCase()}` : "QD330 offline";
  const aiChip = !settings ? null : settings.ai.assistant === "gemini-live" && settings.ai.generator === "meshy"
    ? <span className="chip"><span className={`dot ${state === "offline" ? "bad" : "ok"}`} />Gemini + Meshy</span>
    : <span className="chip"><span className="dot bad" />{settings.ai.assistant !== "gemini-live" && settings.ai.generator !== "meshy" ? "AI keys missing" : settings.ai.assistant !== "gemini-live" ? "Gemini key missing" : "Meshy key missing"}</span>;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span>Morphix</span></div>
        {page !== "assistant" && (state !== "idle" || assistantDraft) && (
          <span className="top-voice small">{state === "listening" ? "Listening…" : assistantDraft || voiceLabel(state)}</span>
        )}
        <span className="spacer" />
        {aiChip}
        <span className="chip"><span className={`dot ${pDot}`} />{pText}</span>
        <button
          className="theme-btn"
          aria-label={theme.resolved === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={() => theme.set(theme.resolved === "dark" ? "light" : "dark")}
        >
          {theme.resolved === "dark" ? "☀️" : "🌙"}
        </button>
        {page !== "assistant" && <MicButton voice={voice} />}
      </header>
      <nav className="rail">
        {(Object.keys(LABELS) as NavItem[]).map((p) => {
          const active = page === p || (p === "library" && (page === "viewer" || page === "prepare"));
          if (p === "settings") return <GrownUpButton key={p} active={active} onOpen={() => setPage("settings")} />;
          return (
            <button key={p} className={active ? "active" : ""} onClick={() => setPage(p)}>
              <span className="emoji">{EMOJI[p]}</span>
              {LABELS[p]}
            </button>
          );
        })}
      </nav>
      <main className="content">
        <PageBoundary page={page}>
          {page === "assistant" && <AssistantPage voice={voice} settings={settings} onOpenProject={openProject} onError={showNotice} />}
          {page === "library" && <LibraryPage onOpen={openProject} />}
          {page === "viewer" && <ViewerPage projectId={projectId} settings={settings} heightEvent={heightEvent} onBrowse={() => setPage("library")} onPrepare={() => setPage("prepare")} onError={showNotice} />}
          {page === "prepare" && <PreparePage projectId={projectId} onBack={() => setPage("viewer")} onError={showNotice} />}
          {page === "printer" && <PrinterPage status={printer} settings={settings} onError={showNotice} />}
          {page === "settings" && <SettingsPage settings={settings} onError={showNotice} />}
        </PageBoundary>
        <JobBar />
        {notice && (
          <div className={`toast ${notice.level}`} onClick={() => setNotice(null)}>
            <div>{notice.level === "error" ? "😟 " : ""}{notice.title}</div>
            {notice.hint && <div className="small" style={{ fontWeight: 600, marginTop: 4 }}>{notice.hint}</div>}
            {notice.code && <div className="small" style={{ opacity: 0.7, marginTop: 4, fontFamily: "ui-monospace, monospace" }}>Error code {notice.code}</div>}
          </div>
        )}
      </main>
      {pending && (
        <div className="modal-backdrop" data-no-drag-scroll>
          <div className="confirm-sheet">
            <div className="muted small" style={{ textTransform: "uppercase", letterSpacing: ".07em" }}>
              {pending.kind === "print" ? "Start printing on the QD330" : pending.kind === "refine" ? "Add colour & detail" : "Create a 3D model"}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, margin: "6px 0" }}>{pending.title}</div>
            <div className="muted confirm-prompt">{pending.prompt}</div>
            <div className="row" style={{ margin: "12px 0", gap: 16 }}>
              {pending.kind === "print"
                ? (pending.details ?? []).map((d) => <span key={d} className="chip">{d}</span>)
                : <span className="chip">{pending.credits} Meshy credits</span>}
              {pending.kind !== "print" && settings && settings.ai.generator === "meshy" && (
                <span className="muted small">{settings.ai.usedToday} of {settings.ai.dailyLimit} jobs used today</span>
              )}
            </div>
            <div className="row" style={{ justifyContent: "flex-end", gap: 12 }}>
              <button className="btn" onClick={() => void api.cancelAction(pending.id)}>Cancel</button>
              <button
                className="btn primary"
                onClick={() =>
                  api.confirmAction(pending.id).then(
                    () => api.getSettings().then(setSettings),
                    (e) => showNotice((e as Error).message),
                  )
                }
              >
                {pending.kind === "print" ? "Start print" : "Confirm"}
              </button>
            </div>
            <div className="muted small" style={{ marginTop: 8 }}>You can also say “yes” to confirm.</div>
          </div>
        </div>
      )}
    </div>
  );
}
