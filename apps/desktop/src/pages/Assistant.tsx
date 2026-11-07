import { useEffect, useRef, useState } from "react";
import type { AssistantTurn, GenerationProgress } from "@morphix/shared";
import { api } from "../bridge";
import { PushToTalk } from "../audio";

const IDEAS = ["A small vase", "A gear", "A star trophy", "A ring"];

export function AssistantPage({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const [proposal, setProposal] = useState<string | null>(null);
  const [gen, setGen] = useState<GenerationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ptt = useRef<PushToTalk | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.conversation().then(setTurns);
    return api.onGenerationProgress(setGen);
  }, []);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns, proposal, gen]);

  const showError = (e: unknown) => {
    setError((e as Error).message ?? String(e));
    setTimeout(() => setError(null), 6000);
  };

  const startTalk = async () => {
    if (busy || recording) return;
    try {
      ptt.current = new PushToTalk(setLevel);
      await ptt.current.start();
      setRecording(true);
    } catch (e) {
      showError(new Error(`Microphone unavailable: ${(e as Error).message}`));
    }
  };

  const stopTalk = async () => {
    if (!ptt.current?.active) return;
    setRecording(false);
    setBusy(true);
    try {
      const { pcm, sampleRate, seconds } = await ptt.current.stop();
      if (seconds < 0.3) return;
      const r = await api.submitRecording(pcm, sampleRate);
      setTurns((t) => [...t, r.turn, r.reply]);
      if (r.proposedPrompt) setProposal(r.proposedPrompt);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const say = async (text: string) => {
    setBusy(true);
    try {
      const r = await api.sendText(text);
      setTurns((t) => [...t, r.turn, r.reply]);
      if (r.proposedPrompt) setProposal(r.proposedPrompt);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!proposal) return;
    const prompt = proposal;
    setProposal(null);
    try {
      const { project, taskId } = await api.createProjectFromPrompt(prompt);
      setGen({ taskId, projectId: project.id, status: "queued", progress: 0, stage: "Starting…" });
    } catch (e) {
      showError(e);
    }
  };

  const generating = gen && (gen.status === "queued" || gen.status === "running");

  return (
    <div className="assistant">
      <section className="card mic-panel">
        <button
          className={`mic ${recording ? "live" : ""} ${busy ? "busy" : ""}`}
          style={{ ["--lvl" as string]: level }}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            void startTalk();
          }}
          onPointerUp={() => void stopTalk()}
          onPointerCancel={() => void stopTalk()}
          aria-label="Hold to talk"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3" />
          </svg>
        </button>
        <div style={{ fontWeight: 650, fontSize: 18 }}>{recording ? "Listening… release to send" : busy ? "Thinking…" : "Hold to talk"}</div>
        <div className="muted small">Push-to-talk · TONOR G11</div>
      </section>

      <section className="card" style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
        <h3>Conversation</h3>
        <div className="transcript" ref={listRef}>
          {turns.length === 0 && <div className="muted">Hold the microphone and say what you'd like to make, or tap an idea below.</div>}
          {turns.map((t) => (
            <div key={t.id} className={`bubble ${t.role}`}>
              {t.text}
              {t.audioUrl && (
                <div>
                  <button className="btn ghost" style={{ minHeight: 38, fontSize: 14 }} onClick={() => new Audio(t.audioUrl).play().catch(showError)}>
                    ▶ Play recording
                  </button>
                </div>
              )}
            </div>
          ))}
          {proposal && (
            <div className="bubble">
              Make a model of <b>“{proposal}”</b>?
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn primary" onClick={() => void create()}>Create model</button>
                <button className="btn" onClick={() => setProposal(null)}>Not now</button>
              </div>
            </div>
          )}
          {gen && (
            <div className="bubble" style={{ minWidth: 320 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>{gen.stage}</span>
                <span className="muted small">{gen.progress}%</span>
              </div>
              <div className="progress" style={{ marginTop: 8 }}><div style={{ width: `${gen.progress}%` }} /></div>
              {gen.status === "succeeded" && (
                <button className="btn primary" style={{ marginTop: 10 }} onClick={() => onOpenProject(gen.projectId)}>Open in viewer</button>
              )}
              {gen.status === "failed" && <div style={{ color: "var(--bad)", marginTop: 8 }}>{gen.error}</div>}
            </div>
          )}
        </div>
        <div className="chips">
          {IDEAS.map((idea) => (
            <button key={idea} className="btn" disabled={busy || Boolean(generating)} onClick={() => void say(idea)}>{idea}</button>
          ))}
        </div>
      </section>
      {error && <div className="toast">{error}</div>}
    </div>
  );
}
