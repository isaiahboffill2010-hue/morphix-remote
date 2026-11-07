import { useEffect, useRef, useState } from "react";
import type { AppSettings, GenerationProgress } from "@morphix/shared";
import { api } from "../bridge";
import { MicButton, voiceLabel, type Voice } from "../App";
import { TextEntry } from "../components/Keyboard";

const DEMO_IDEAS = ["A small vase", "A gear", "A star trophy", "A ring"];
const LIVE_IDEAS = ["A cute dragon figurine", "A phone stand", "A tiny astronaut", "A desk organizer"];

interface Props {
  voice: Voice;
  settings: AppSettings | null;
  onOpenProject: (id: string) => void;
  onError: (message: string) => void;
}

export function AssistantPage({ voice, settings, onOpenProject, onError }: Props) {
  const [gen, setGen] = useState<GenerationProgress | null>(null);
  const [typing, setTyping] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => api.onGenerationProgress(setGen), []);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [voice.turns, voice.userDraft, voice.assistantDraft, voice.proposal, gen]);

  const createDemo = async () => {
    if (!voice.proposal) return;
    const prompt = voice.proposal;
    voice.setProposal(null);
    try {
      const r = await api.createProjectFromPrompt(prompt);
      if ("taskId" in r) setGen({ taskId: r.taskId, projectId: r.project.id, status: "queued", progress: 0, stage: "Starting…" });
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const generating = gen && (gen.status === "queued" || gen.status === "running");
  const ideas = voice.live ? LIVE_IDEAS : DEMO_IDEAS;
  const meshy = settings?.ai.generator === "meshy";

  return (
    <div className="assistant-page">
      <section className="card mic-panel">
        <MicButton voice={voice} big />
        <div style={{ fontWeight: 650, fontSize: 18 }}>{voiceLabel(voice.state)}</div>
        <div className="muted small">
          {voice.live ? `Gemini Live · ${settings?.ai.geminiModel}` : "Demo voice · add a Gemini key for real conversations"}
        </div>
        {meshy && <div className="muted small">Meshy {settings?.ai.meshyModel} · {settings?.ai.previewCredits} credits per model</div>}
      </section>

      <section className="card" style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
        <h3>Conversation</h3>
        <div className="transcript" ref={listRef}>
          {voice.turns.length === 0 && !voice.userDraft && (
            <div className="muted">Hold the microphone and say what you'd like to make — or tap an idea below.</div>
          )}
          {voice.turns.map((t) => (
            <div key={t.id} className={`bubble ${t.role}`}>
              {t.text}
              {t.audioUrl && (
                <div>
                  <button className="btn ghost" style={{ minHeight: 38, fontSize: 14 }} onClick={() => new Audio(t.audioUrl).play().catch((e) => onError(String(e)))}>
                    ▶ Play recording
                  </button>
                </div>
              )}
            </div>
          ))}
          {voice.userDraft && <div className="bubble user draft">{voice.userDraft}</div>}
          {voice.assistantDraft && <div className="bubble assistant draft">{voice.assistantDraft}</div>}
          {voice.proposal && !voice.live && (
            <div className="bubble assistant">
              Make a model of <b>“{voice.proposal}”</b>?
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn primary" onClick={() => void createDemo()}>Create model</button>
                <button className="btn" onClick={() => voice.setProposal(null)}>Not now</button>
              </div>
            </div>
          )}
          {gen && (
            <div className="bubble assistant gen-card">
              <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
                {gen.thumbnailUrl && <img className="gen-thumb" src={gen.thumbnailUrl} alt="" />}
                <div style={{ flex: 1 }}>
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
              </div>
            </div>
          )}
        </div>
        <div className="chips">
          <button className="btn" onClick={() => setTyping(true)}>⌨ Type an idea</button>
          {ideas.map((idea) => (
            <button key={idea} className="btn" disabled={Boolean(generating) || voice.state === "thinking"} onClick={() => void voice.sendText(voice.live ? `Make me ${idea.toLowerCase()}.` : idea)}>
              {idea}
            </button>
          ))}
        </div>
      </section>
      {typing && (
        <TextEntry
          title="What should Morphix make?"
          hint="e.g. a dragon figurine holding a shield"
          submitLabel="Send"
          onCancel={() => setTyping(false)}
          onSubmit={(text) => {
            setTyping(false);
            void voice.sendText(text);
          }}
        />
      )}
    </div>
  );
}
