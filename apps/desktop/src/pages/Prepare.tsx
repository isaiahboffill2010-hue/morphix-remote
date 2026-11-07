import { useEffect, useState } from "react";
import type { ModelVersion, PrepareSettings, PrepareSummary, PrintControlStatus, Project } from "@morphix/shared";
import { api } from "../bridge";

const LAYERS: [string, number][] = [["Draft 0.28", 0.28], ["Normal 0.20", 0.2], ["Fine 0.12", 0.12]];
const INFILL = [10, 15, 25, 50];
const SUPPORTS: [string, PrepareSettings["supports"]][] = [["None", "none"], ["Auto", "auto"], ["Plate only", "buildplate"]];
const STAGES: Record<string, string> = {
  load: "Loading model", validate: "Checking the mesh", repair: "Repairing", place: "Orienting & placing",
  slice: "Slicing (this can take a few minutes)", gx: "Building printer file", done: "Done",
};

const duration = (s: number | null | undefined) => {
  if (!s) return "–";
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

interface Props {
  projectId: string | null;
  onBack: () => void;
  onError: (m: string) => void;
}

export function PreparePage({ projectId, onBack, onError }: Props) {
  const [data, setData] = useState<{ project: Project; versions: ModelVersion[] } | null>(null);
  const [settings, setSettings] = useState<PrepareSettings>({ layerHeightMm: 0.2, infillPercent: 15, supports: "auto" });
  const [summary, setSummary] = useState<PrepareSummary | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [control, setControl] = useState<PrintControlStatus | null>(null);

  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId).then(setData);
    api.latestPrintJob(projectId).then((s) => {
      if (s) {
        setSummary(s);
        setSettings(s.settings);
      }
    });
    api.printStatus().then(setControl);
    return api.onAppEvent((e) => {
      if (e.type === "prepare-progress") setStage(e.stage);
      if (e.type === "print-status") setControl(e.status);
    });
  }, [projectId]);

  if (!projectId || !data) return <div className="empty">Open a model first, then tap “Prepare to print”.</div>;
  const v = data.versions[0];
  if (!v) return <div className="empty">This project has no model yet.</div>;

  const run = async () => {
    setStage("load");
    setSummary(null);
    try {
      setSummary(await api.preparePrint(v.id, settings));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setStage(null);
    }
  };
  const print = () => summary && api.requestPrint(summary.jobId).catch((e) => onError((e as Error).message));
  const busy = stage !== null;
  const est = summary?.estimates;
  const printLocked = !control?.enabled ? "Printer control is locked until the operator validation is done" : !summary?.gx.ok ? "Needs a sliced printer file" : !summary.gx.verified && !control.gxVerified ? "Printer file format not yet verified against Afinia output" : null;

  return (
    <div className="prepare">
      <section className="card prep-settings">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Print settings</h3>
          <button className="btn ghost" style={{ minHeight: 40 }} onClick={onBack}>‹ Back</button>
        </div>
        <div className="muted small">{data.project.title} · v{v.version} · target height {v.targetHeightMm ? `${v.targetHeightMm.toFixed(0)} mm` : "original"}</div>
        <div className="field-label">Quality</div>
        <div className="seg">{LAYERS.map(([l, h]) => <button key={h} className={settings.layerHeightMm === h ? "on" : ""} onClick={() => setSettings({ ...settings, layerHeightMm: h })}>{l}</button>)}</div>
        <div className="field-label">Infill</div>
        <div className="seg">{INFILL.map((i) => <button key={i} className={settings.infillPercent === i ? "on" : ""} onClick={() => setSettings({ ...settings, infillPercent: i })}>{i}%</button>)}</div>
        <div className="field-label">Supports</div>
        <div className="seg">{SUPPORTS.map(([l, m]) => <button key={m} className={settings.supports === m ? "on" : ""} onClick={() => setSettings({ ...settings, supports: m })}>{l}</button>)}</div>
        <button className="btn primary" style={{ marginTop: "auto" }} disabled={busy} onClick={() => void run()}>
          {busy ? STAGES[stage!] ?? "Working…" : summary ? "Prepare again" : "Prepare & slice"}
        </button>
      </section>

      <section className="card prep-result">
        <h3>Result</h3>
        {!summary && !busy && <div className="muted">Choose settings and tap “Prepare &amp; slice”. Morphix repairs the mesh, scales it, picks a stable orientation and slices it for the QD330.</div>}
        {busy && (
          <div>
            <div style={{ fontWeight: 600 }}>{STAGES[stage!] ?? stage}</div>
            <div className="progress" style={{ marginTop: 10 }}><div style={{ width: `${(Object.keys(STAGES).indexOf(stage!) + 1) * 14}%` }} /></div>
          </div>
        )}
        {summary && (
          <>
            {summary.error && <div className="bad-text">{summary.error}</div>}
            <div className="result-grid">
              <div className="stat-tile"><div className="k">Size</div><div className="v">{summary.size ? `${summary.size.x.toFixed(0)}×${summary.size.y.toFixed(0)}×${summary.size.z.toFixed(0)}` : "–"}<small> mm</small></div></div>
              <div className="stat-tile"><div className="k">Fits QD330</div><div className="v" style={{ color: summary.fits ? "var(--ok)" : "var(--bad)" }}>{summary.fits === undefined ? "–" : summary.fits ? "Yes" : "No"}</div></div>
              <div className="stat-tile"><div className="k">Print time</div><div className="v">{duration(est?.printTimeS)}</div></div>
              <div className="stat-tile"><div className="k">Filament</div><div className="v">{est?.filamentG ? `${est.filamentG.toFixed(0)}` : "–"}<small> g</small></div></div>
            </div>
            {est?.source === "mesh-heuristic" && <div className="muted small">Time and filament are rough guesses from the model volume (no slicer run).</div>}
            <div className="stat"><span className="muted">Slicer</span><span style={{ color: summary.slicer.ok ? "var(--ok)" : "var(--warn)" }}>{summary.slicer.ok ? (summary.slicer.name ?? "OK") : summary.slicer.message ?? summary.slicer.reason}</span></div>
            <div className="stat"><span className="muted">Layers</span><span>{est?.layerCount ?? "–"}</span></div>
            <div className="stat"><span className="muted">Printer file</span><span>{summary.gx.ok ? `${summary.gx.fileName} · ${summary.gx.verified ? "verified" : "unverified format"}` : summary.gx.reason ?? "not created"}</span></div>
            {summary.repairs.length > 0 && <div className="stat"><span className="muted">Repaired</span><span className="small">{summary.repairs.slice(0, 3).join(", ")}</span></div>}
            {[...summary.issues, ...summary.warnings].slice(0, 4).map((w, i) => <div key={i} className="muted small warn-line">⚠ {w}</div>)}
          </>
        )}
        <div className="row" style={{ marginTop: "auto", justifyContent: "space-between" }}>
          <span className="muted small" style={{ maxWidth: 360 }}>{summary && printLocked ? `🔒 ${printLocked}` : summary ? "You'll be asked to confirm before anything is sent." : ""}</span>
          <button className="btn primary" disabled={!summary?.ok || Boolean(printLocked) || busy || Boolean(control?.job)} onClick={() => void print()}>Print…</button>
        </div>
      </section>
    </div>
  );
}
