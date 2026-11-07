import { useEffect, useState } from "react";
import type { Project } from "@morphix/shared";
import { api } from "../bridge";

const STATE_LABEL: Partial<Record<Project["state"], string>> = {
  generating: "Generating…",
  reviewing: "Ready to review",
  failed: "Failed",
  sizing: "Sizing",
};

export function LibraryPage({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    const load = () => api.listProjects().then(setProjects);
    void load();
    return api.onGenerationProgress((p) => {
      if (p.status === "succeeded" || p.status === "failed") void load();
    });
  }, []);

  if (projects === null) return <div className="empty">Loading library…</div>;
  if (!projects.length)
    return (
      <div className="empty">
        <div>
          <div style={{ fontSize: 20, fontWeight: 650 }}>No models yet</div>
          <div className="muted">Models you create are saved on this Raspberry Pi.</div>
        </div>
      </div>
    );

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Model library</h2>
        <span className="muted small">{projects.length} saved on this Pi</span>
      </div>
      <div className="grid">
        {projects.map((p) => (
          <button key={p.id} className="tile" onClick={() => onOpen(p.id)} disabled={!p.latestVersionId}>
            <div className="thumb">{p.thumbnailUrl ? <img src={p.thumbnailUrl} alt="" /> : <span>{p.latestVersionId ? "No preview yet" : "…"}</span>}</div>
            <div className="meta">
              <div className="title">{p.title}</div>
              <div className="muted small">{STATE_LABEL[p.state] ?? p.state} · {new Date(p.createdAt).toLocaleDateString()}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
