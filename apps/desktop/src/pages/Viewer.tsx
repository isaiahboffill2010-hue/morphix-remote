import { useEffect, useState } from "react";
import type { AppSettings, ModelVersion, Project } from "@morphix/shared";
import { MM_PER_INCH, fitsBuildVolume } from "@morphix/domain";
import { QD330_BUILD_VOLUME_MM } from "@morphix/shared";
import { api } from "../bridge";
import { ModelViewer, type ModelSize } from "../components/ModelViewer";
import { useTheme } from "../theme";

const PRESETS: [string, number][] = [["Tiny · 2 in", 2 * MM_PER_INCH], ["Small · 3 in", 3 * MM_PER_INCH], ["Medium · 4 in", 4 * MM_PER_INCH], ["Big · 6 in", 6 * MM_PER_INCH]];
const KIND_LABEL: Record<ModelVersion["kind"], string> = { demo: "Demo", preview: "Shape", refine: "Colour" };

interface Props {
  projectId: string | null;
  settings: AppSettings | null;
  heightEvent: { versionId: string; heightMm: number; n: number } | null;
  onBrowse: () => void;
  onPrepare: () => void;
  onError: (message: string) => void;
}

export function ViewerPage({ projectId, settings, heightEvent, onBrowse, onPrepare, onError }: Props) {
  const [data, setData] = useState<{ project: Project; versions: ModelVersion[] } | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [size, setSize] = useState<{ native: ModelSize; scaled: ModelSize } | null>(null);
  const theme = useTheme().resolved;

  const load = (keepVersion = false) => {
    if (!projectId) return;
    api.getProject(projectId).then((d) => {
      setData(d);
      const v = (keepVersion && d?.versions.find((x) => x.id === versionId)) || d?.versions[0];
      setVersionId(v?.id ?? null);
      setHeight(v?.targetHeightMm ?? null);
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), [projectId]);
  useEffect(
    () =>
      api.onGenerationProgress((p) => {
        if (p.projectId === projectId && p.status === "succeeded") load();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  );
  useEffect(() => {
    if (heightEvent && heightEvent.versionId === versionId) setHeight(heightEvent.heightMm);
    else if (heightEvent) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heightEvent?.n]);

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

  const v = data.versions.find((x) => x.id === versionId) ?? data.versions[0];
  if (!v) return <div className="empty">This project has no model yet.</div>;

  const setTarget = async (mm: number | null) => {
    setHeight(mm);
    try {
      await api.setTargetHeight(v.id, mm ? Math.round(mm * 10) / 10 : null);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const nudge = (d: number) => setTarget(Math.max(5, Math.round(((height ?? size?.scaled.z ?? 50) + d) * 10) / 10));
  const fits = size ? fitsBuildVolume(size.scaled, QD330_BUILD_VOLUME_MM) : true;
  const fmt = (mm: number) => `${mm.toFixed(1)} mm`;
  const canRefine = v.source === "meshy" && v.kind === "preview" && !data.versions.some((x) => x.kind === "refine" && x.version > v.version);

  return (
    <div className="viewer">
      <div style={{ position: "relative", minHeight: 0, display: "grid" }}>
        <ModelViewer
          key={`${v.id}-${theme}`}
          url={v.url}
          format={v.format}
          targetHeightMm={height}
          onMeasured={(native, scaled) => setSize({ native, scaled })}
          onError={onError}
          onThumbnail={v.thumbnailUrl ? undefined : (png) => void api.saveThumbnail(v.id, png)}
        />
        <div className="overlay">
          {data.versions.length > 1 &&
            data.versions.map((x) => (
              <button key={x.id} className={`chip chip-btn ${x.id === v.id ? "on" : ""}`} onClick={() => { setVersionId(x.id); setHeight(x.targetHeightMm); }}>
                v{x.version} · {KIND_LABEL[x.kind]}
              </button>
            ))}
          {data.versions.length <= 1 && <span className="chip">Drag to rotate · pinch to zoom</span>}
        </div>
      </div>
      <aside className="side">
        <div className="card">
          <h3>{data.project.title}</h3>
          <div className="muted small">v{v.version} · {v.source === "demo" ? "demo model" : `Meshy ${KIND_LABEL[v.kind].toLowerCase()}`} · {(v.bytes / 1e6).toFixed(1)} MB</div>
          {canRefine && (
            <button className="btn" style={{ width: "100%", marginTop: 8 }} onClick={() => api.requestRefine(v.id).catch((e) => onError((e as Error).message))}>
              🎨 Add colour · {settings?.ai.refineCredits ?? 10} credits
            </button>
          )}
        </div>
        <div className="card">
          <h3>Size</h3>
          {size ? (
            <>
              <div className="stat"><span className="muted">Width</span><span>{fmt(size.scaled.x)}</span></div>
              <div className="stat"><span className="muted">Depth</span><span>{fmt(size.scaled.y)}</span></div>
              <div className="stat"><span className="muted">Height</span><span>{fmt(size.scaled.z)} · {(size.scaled.z / MM_PER_INCH).toFixed(2)} in</span></div>
              <div className="stat">
                <span className="muted">Fits the printer?</span>
                <span style={{ color: fits ? "var(--ok)" : "var(--bad)", fontWeight: 800 }}>{fits ? "Fits! ✅" : "Too big ❌"}</span>
              </div>
            </>
          ) : (
            <div className="muted">Measuring…</div>
          )}
        </div>
        <div className="card">
          <h3>How big? 📏</h3>
          <div className="size-grid">
            {PRESETS.map(([label, mm]) => (
              <button key={label} className={`btn ${height && Math.abs(height - mm) < 0.5 ? "primary" : ""}`} onClick={() => void setTarget(mm)}>{label}</button>
            ))}
            <button className="btn" onClick={() => void nudge(-5)}>− 5 mm</button>
            <button className="btn" onClick={() => void nudge(5)}>+ 5 mm</button>
            {v.source === "demo" && (
              <button className="btn ghost" style={{ gridColumn: "1 / -1" }} onClick={() => setTarget(null)}>Original size</button>
            )}
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>Or just say “make it six inches tall”.</div>
        </div>
        <button className="btn primary" style={{ width: "100%", flex: "none" }} disabled={!fits} onClick={onPrepare}>Get it ready to print 🖨️</button>
      </aside>
    </div>
  );
}
