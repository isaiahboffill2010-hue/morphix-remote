import { useEffect, useState } from "react";
import type { AppSettings, GuardianView, PrintControlStatus, PrinterStatus } from "@morphix/shared";
import { api } from "../bridge";

const ALERT_COLORS: Record<string, string> = {
  possible_failure: "var(--warn)", confirmed_failure: "var(--bad)", pause_requested: "var(--bad)",
  pause_confirmed: "var(--ok)", pause_unconfirmed: "var(--bad)",
};

export function PrinterPage({ status, settings, onError }: { status: PrinterStatus | null; settings: AppSettings | null; onError: (m: string) => void }) {
  const [camError, setCamError] = useState(false);
  const [camKey, setCamKey] = useState(0);
  const [guardian, setGuardian] = useState<GuardianView | null>(null);
  const [control, setControl] = useState<PrintControlStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api.guardian().then(setGuardian);
    api.printStatus().then(setControl);
    return api.onAppEvent((e) => {
      if (e.type === "guardian") setGuardian(e.snapshot);
      if (e.type === "print-status") setControl(e.status);
    });
  }, []);

  const g = async (cmd: Parameters<typeof api.guardianCommand>[0]) => {
    try {
      setGuardian(await api.guardianCommand(cmd));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const act = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    const r = await fn();
    setMessage(r.message);
    if (!r.ok) onError(r.message);
  };

  const t = status?.temps;
  const job = control?.job;
  const alert = guardian?.alert;
  return (
    <div className="printer">
      <div style={{ position: "relative", minHeight: 0 }}>
        {settings && !camError ? (
          <img key={camKey} className="camera" src={settings.cameraStreamUrl} alt="QD330 live camera" onError={() => setCamError(true)} />
        ) : (
          <div className="empty card" style={{ height: "100%" }}>
            <div>
              <div style={{ fontWeight: 650 }}>{camError ? "Camera not reachable" : "Loading camera…"}</div>
              {camError && <button className="btn" style={{ marginTop: 10 }} onClick={() => { setCamError(false); setCamKey((k) => k + 1); }}>Retry</button>}
            </div>
          </div>
        )}
        <div className="overlay">
          <span className="chip"><span className="dot bad" />LIVE</span>
          {guardian?.running && <span className="chip"><span className={`dot ${alert ? "bad" : "ok"}`} />Guardian · {guardian.label}</span>}
        </div>
      </div>
      <aside className="side">
        {job && (
          <div className="card">
            <h3>Printing</h3>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="small">{job.fileName}</span>
              <span style={{ fontWeight: 700 }}>{job.progress}%</span>
            </div>
            <div className="progress" style={{ margin: "8px 0" }}><div style={{ width: `${job.progress}%` }} /></div>
            <div className="muted small">{job.phase}{job.layer[1] ? ` · layer ${job.layer[0]}/${job.layer[1]}` : ""}{job.offline ? " · printer offline" : ""}</div>
            {control?.enabled ? (
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn" onClick={() => void act(api.pausePrint)}>Pause</button>
                <button className="btn danger-btn" onClick={() => confirm("Cancel this print?") && void act(api.cancelPrint)}>Cancel</button>
              </div>
            ) : (
              <div className="muted small" style={{ marginTop: 6 }}>Use the printer's screen to pause or cancel.</div>
            )}
            {(message || control?.lastMessage) && <div className="muted small" style={{ marginTop: 6 }}>{message || control?.lastMessage}</div>}
          </div>
        )}
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>AI Guardian</h3>
            <button className="btn" style={{ minHeight: 40 }} onClick={() => void g(guardian?.running ? "stop" : "start")}>{guardian?.running ? "Stop" : "Start watching"}</button>
          </div>
          <div className="muted small" style={{ margin: "6px 0" }}>
            {guardian ? `${guardian.label} · camera ${guardian.camera}${guardian.gemini ? " · Gemini checks on" : ""}` : "–"}
          </div>
          {alert && (
            <div className="alert-box" style={{ borderColor: ALERT_COLORS[alert.state] ?? "var(--line)" }}>
              <div style={{ fontWeight: 700, color: ALERT_COLORS[alert.state] }}>{alert.kind} · {alert.state.replaceAll("_", " ")}</div>
              {alert.explanation && <div className="small" style={{ marginTop: 4 }}>{alert.explanation}</div>}
              {alert.evidenceUrls.length > 0 && <img className="evidence" src={alert.evidenceUrls[alert.evidenceUrls.length - 1]} alt="evidence" />}
              <div className="row" style={{ marginTop: 8, gap: 6 }}>
                {alert.state !== "pause_confirmed" && (
                  <button className="btn" style={{ minHeight: 42 }} onClick={() => void g("requestPause")}>{guardian?.pauseAvailable ? "Pause print" : "How to pause"}</button>
                )}
                <button className="btn ghost" style={{ minHeight: 42 }} onClick={() => void g("dismiss")}>It's fine</button>
                <button className="btn ghost" style={{ minHeight: 42 }} onClick={() => void g("resolve")}>Resolved</button>
              </div>
            </div>
          )}
          {guardian?.running && !alert && (
            <button className="btn ghost" style={{ minHeight: 40, marginTop: 4 }} onClick={() => void g("resetBaseline")}>Re-learn scene</button>
          )}
        </div>
        <div className="card">
          <h3>Status</h3>
          <div className="stat"><span className="muted">Connection</span><span style={{ color: status?.online ? "var(--ok)" : "var(--bad)" }}>{status?.online ? "Online" : "Offline"}</span></div>
          <div className="stat"><span className="muted">State</span><span>{status?.machine ?? "–"}</span></div>
          <div className="stat"><span className="muted">Nozzle / Bed</span><span>{t?.nozzle ? `${t.nozzle.current.toFixed(0)}°` : "–"} / {t?.bed ? `${t.bed.current.toFixed(0)}°` : "–"}</span></div>
          <div className="stat"><span className="muted">Print control</span><span style={{ color: control?.enabled ? "var(--ok)" : "var(--warn)" }}>{control?.enabled ? "Enabled" : "Locked"}</span></div>
        </div>
      </aside>
    </div>
  );
}
