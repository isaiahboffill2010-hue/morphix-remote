import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AppSettings, AssistantTurn, PendingAction, PrinterStatus, VoiceEvent } from "@morphix/shared";
import { api } from "./bridge";
import { AudioOut, PushToTalk } from "./audio";
import { installDragScroll } from "./dragScroll";
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

const ICONS: Record<RailPage, ReactNode> = {
  assistant: <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3" />,
  library: <path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z" />,
  viewer: <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 0v20M3 7l9 5 9-5" />,
  printer: <path d="M6 9V3h12v6M6 18H4v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7h-2M8 14h8v7H8z" />,
  settings: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" />,
};
const LABELS: Record<RailPage, string> = { assistant: "Create", library: "Library", viewer: "Viewer", printer: "Printer", settings: "Settings" };
const STATE_TEXT: Record<VoiceState, string> = {
  idle: "Hold to talk", ready: "Hold to talk", listening: "Listening… release to send", connecting: "Connecting to Gemini…",
  thinking: "Thinking…", speaking: "Speaking… hold to interrupt", offline: "Hold to talk",
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

export function App() {
  const [page, setPage] = useState<Page>("assistant");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [printer, setPrinter] = useState<PrinterStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [notice, setNotice] = useState<{ level: string; message: string } | null>(null);
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

  const showNotice = useCallback((message: string, level = "error") => {
    setNotice({ level, message });
    setTimeout(() => setNotice(null), 6500);
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
        else if (e.type === "notice") showNotice(e.message, e.level);
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
    return () => offs.forEach((off) => off());
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
  }, [showNotice]);

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
        {page !== "assistant" && <MicButton voice={voice} />}
      </header>
      <nav className="rail">
        {(Object.keys(LABELS) as RailPage[]).map((p) => (
          <button key={p} className={page === p || (p === "viewer" && page === "prepare") ? "active" : ""} onClick={() => setPage(p)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{ICONS[p]}</svg>
            {LABELS[p]}
          </button>
        ))}
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
        {notice && <div className={`toast ${notice.level}`} onClick={() => setNotice(null)}>{notice.message}</div>}
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
