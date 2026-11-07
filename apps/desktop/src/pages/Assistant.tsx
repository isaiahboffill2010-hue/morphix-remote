import { useEffect, useRef, useState } from "react";
import type { AppSettings, GenerationProgress, SmartSearchState } from "@morphix/shared";
import { api } from "../bridge";
import { MicButton, voiceLabel, type Voice } from "../App";
import { TextEntry } from "../components/Keyboard";

const IDEAS: [string, string][] = [["🐉", "a cute dragon"], ["📱", "a phone stand"], ["🚀", "a rocket ship"], ["🦖", "a dinosaur"]];

interface Props {
  voice: Voice;
  settings: AppSettings | null;
  onOpenProject: (id: string) => void;
  onError: (message: string) => void;
}

export function AssistantPage({ voice, settings, onOpenProject, onError }: Props) {
  const [gen, setGen] = useState<GenerationProgress | null>(null);
  const [typing, setTyping] = useState(false);
  const [search, setSearch] = useState<SmartSearchState | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => api.onGenerationProgress(setGen), []);
  useEffect(() => { const load=()=>api.smartSearchState().then(setSearch).catch(()=>{}); load(); const id=setInterval(load,1500); return()=>clearInterval(id); }, []);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [voice.turns, voice.userDraft, voice.assistantDraft, voice.proposal, gen]);

  const generating = gen && (gen.status === "queued" || gen.status === "running");
  const meshy = settings?.ai.generator === "meshy";

  return (
    <div className="assistant-page">
      <section className="card mic-panel">
        <MicButton voice={voice} big />
        <div style={{ fontWeight: 650, fontSize: 18 }}>{voiceLabel(voice.state)}</div>
        <div className="muted small">{voice.live ? "Tell me what to make — like “a dragon holding a shield”." : "A grown-up needs to add the Gemini key first."}</div>
        {!meshy && <div className="muted small">The Meshy key is missing too.</div>}
      </section>

      <section className="card" style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
        <h2 className="hero-title">Let’s make something! ✨</h2>
        <div className="transcript" ref={listRef}>
          {voice.turns.length === 0 && !voice.userDraft && (
            <div className="muted">Hold the big button and tell me what you want to make. Or tap an idea below!</div>
          )}
          {voice.turns.map((t) => (
            <div key={t.id} className={`bubble ${t.role}`}>
              {t.text}
              {t.audioUrl && (
                <div>
                  <button className="btn ghost" style={{ minHeight: 38, fontSize: 14 }} onClick={() => new Audio(t.audioUrl).play().catch((e) => onError(String(e)))}>
                    ▶ Hear it
                  </button>
                </div>
              )}
            </div>
          ))}
          {voice.userDraft && <div className="bubble user draft">{voice.userDraft}</div>}
          {voice.assistantDraft && <div className="bubble assistant draft">{voice.assistantDraft}</div>}
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
                    <button className="btn primary" style={{ marginTop: 10 }} onClick={() => onOpenProject(gen.projectId)}>Look at it! 👀</button>
                  )}
                  {gen.status === "failed" && <div style={{ color: "var(--bad)", marginTop: 8 }}>{gen.error}</div>}
                </div>
              </div>
            </div>
          )}
          {search?.status === "searching" && <div className="bubble assistant">Searching real model libraries…</div>}
          {search?.status === "failed" && <div className="bubble assistant" style={{color:"var(--bad)"}}>{search.error} Ask me to use Meshy or CAD instead.</div>}
          {search?.status === "ready" && search.results.map((r)=><div className="bubble assistant gen-card" key={r.id}><div className="row" style={{gap:12,alignItems:"flex-start"}}>{r.imageUrl&&<img className="gen-thumb" src={r.imageUrl} alt=""/>}<div style={{flex:1}}><b>{r.name}</b><div className="muted small">{r.source} · {r.license||"Check license on source"}</div><p>{r.description}</p>{r.parts.length>0&&<div className="small"><b>Printed parts:</b> {r.parts.join(", ")}</div>}{r.nonPrintedParts.length>0&&<div className="small"><b>Also needs:</b> {r.nonPrintedParts.join(", ")}</div>}<div className="row" style={{marginTop:8}}><button className="btn ghost" onClick={()=>window.open(r.pageUrl,"_blank")}>Source</button><button className="btn primary" onClick={()=>api.selectSmartModel(r.id).then(()=>setSearch({...search,selectedId:r.id})).catch(e=>onError(String(e)))}>Choose</button><label className="btn ghost">Import parts<input hidden type="file" multiple accept=".stl,.obj,.ply,.glb,.3mf" onChange={async(e)=>{try{const files=await Promise.all(Array.from(e.target.files||[]).map(async f=>({name:f.name,bytes:await f.arrayBuffer()})));if(files.length){const out=await api.importSmartModel(r.id,files);onOpenProject(out.projectId)}}catch(err){onError(String(err))}}}/></label></div></div></div></div>)}
        </div>
        <div className="chips">
          <button className="btn" onClick={() => setTyping(true)}>⌨️ Type it</button>
          {IDEAS.map(([emoji, idea]) => (
            <button key={idea} className="btn" disabled={Boolean(generating) || voice.state === "thinking"} onClick={() => void voice.sendText(`Make me ${idea}.`)}>
              {emoji} {idea.replace(/^an? /, "")}
            </button>
          ))}
        </div>
      </section>
      {typing && (
        <TextEntry
          title="What should I make?"
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
