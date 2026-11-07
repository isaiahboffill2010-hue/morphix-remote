import { useEffect, useState } from "react";
import type { ModelVersion, Project } from "@morphix/shared";
import { MM_PER_INCH, fitsBuildVolume } from "@morphix/domain";
import { QD330_BUILD_VOLUME_MM } from "@morphix/shared";
import { api } from "../bridge";
import { ModelViewer, type ModelSize } from "../components/ModelViewer";

const PRESETS: [string, number][] = [["2 in", 2 * MM_PER_INCH], ["4 in", 4 * MM_PER_INCH], ["6 in", 6 * MM_PER_INCH], ["50 mm", 50]];

export function ViewerPage({ projectId, onBrowse }: { projectId: string | null; onBrowse: () => void }) {
  const [data, setData] = useState<{ project: Project; versions: ModelVersion[] } | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [size, setSize] = useState<{ native: ModelSize; scaled: ModelSize } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId).then((d) => {
      setData(d);
      setHeight(d?.versions[0]?.targetHeightMm ?? null);
    });
  }, [projectId]);

  if (!projectId || !data) {
    return (
      <div className="empty">
        <div>
          <div style={{ fontSize: 20, fontWeight: 650 }}>No model open</div>
          <div className="muted" style={{ marginBottom: 12 }}>Pick one from the library.</div>
          <button className="btn primary" onClick={onBrowse}>Open library</button>
        </div>
      </div>
    );
  }

  const v = data.versions[0];
  if (!v) return <div className="empty">This project has no model yet.</div>;

  const setTarget = async (mm: number | null) => {
    setHeight(mm);
    if (mm) {
      try {
        await api.setTargetHeight(v.id, Math.round(mm * 10) / 10);
      } catch (e) {
        setError((e as Error).message);
      }
    }
  };
  const nudge = (d: number) => setTarget(Math.max(5, Math.round(((height ?? size?.scaled.z ?? 50) + d) * 10) / 10));
  const fits = size ? fitsBuildVolume(size.scaled, QD330_BUILD_VOLUME_MM) : true;
  const fmt = (mm: number) => `${mm.toFixed(1)} mm`;

  return (
    <div className="viewer">
      <div style={{ position: "relative", minHeight: 0, display: "grid" }}>
        <ModelViewer
          url={v.url}
          format={v.format}
          targetHeightMm={height}
          onMeasured={(native, scaled) => setSize({ native, scaled })}
          onError={setError}
          onThumbnail={data.project.thumbnailUrl ? undefined : (png) => void api.saveThumbnail(v.id, png)}
        />
        <div className="overlay">
          <span className="chip">Drag to rotate · pinch to zoom · two fingers to pan</span>
        </div>
        {error && <div className="toast">{error}</div>}
      </div>
      <aside className="side">
        <div className="card">
          <h3>{data.project.title}</h3>
          <div className="muted small">Version {v.version} · {v.source === "demo" ? "demo model" : "Meshy"} · {(v.bytes / 1024).toFixed(0)} KB</div>
        </div>
        <div className="card">
          <h3>Size</h3>
          {size ? (
            <>
              <div className="stat"><span className="muted">Width</span><span>{fmt(size.scaled.x)}</span></div>
              <div className="stat"><span className="muted">Depth</span><span>{fmt(size.scaled.y)}</span></div>
              <div className="stat"><span className="muted">Height</span><span>{fmt(size.scaled.z)} · {(size.scaled.z / MM_PER_INCH).toFixed(2)} in</span></div>
              <div className="stat">
                <span className="muted">QD330 fit</span>
                <span style={{ color: fits ? "var(--ok)" : "var(--bad)", fontWeight: 650 }}>{fits ? "Fits" : "Too large"}</span>
              </div>
            </>
          ) : (
            <div className="muted">Measuring…</div>
          )}
        </div>
        <div className="card">
          <h3>Target height</h3>
          <div className="size-grid">
            {PRESETS.map(([label, mm]) => (
              <button key={label} className={`btn ${height && Math.abs(height - mm) < 0.5 ? "primary" : ""}`} onClick={() => void setTarget(mm)}>{label}</button>
            ))}
            <button className="btn" onClick={() => void nudge(-5)}>− 5 mm</button>
            <button className="btn" onClick={() => void nudge(5)}>+ 5 mm</button>
          </div>
          <button className="btn ghost" style={{ width: "100%", marginTop: 8 }} onClick={() => setTarget(null)}>Original size</button>
        </div>
      </aside>
    </div>
  );
}
