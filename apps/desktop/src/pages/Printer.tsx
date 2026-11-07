import { useEffect, useState } from "react";
import type { AppSettings, PrinterInfo, PrinterStatus } from "@morphix/shared";
import { api } from "../bridge";

export function PrinterPage({ status, settings }: { status: PrinterStatus | null; settings: AppSettings | null }) {
  const [info, setInfo] = useState<PrinterInfo | null>(null);
  const [camError, setCamError] = useState(false);
  const [camKey, setCamKey] = useState(0);

  useEffect(() => {
    api.printerInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  const t = status?.temps;
  return (
    <div className="printer">
      <div style={{ position: "relative", minHeight: 0 }}>
        {settings && !camError ? (
          <img
            key={camKey}
            className="camera"
            src={settings.cameraStreamUrl}
            alt="QD330 live camera"
            onError={() => setCamError(true)}
          />
        ) : (
          <div className="empty card" style={{ height: "100%" }}>
            <div>
              <div style={{ fontWeight: 650 }}>{camError ? "Camera not reachable" : "Loading camera…"}</div>
              {camError && (
                <button className="btn" style={{ marginTop: 10 }} onClick={() => { setCamError(false); setCamKey((k) => k + 1); }}>Retry</button>
              )}
            </div>
          </div>
        )}
        <div className="overlay"><span className="chip"><span className="dot bad" />LIVE · QD330 camera</span></div>
      </div>
      <aside className="side">
        <div className="badge">Observation only — print controls unlock in Phase 5 after validation</div>
        <div className="card">
          <h3>Status</h3>
          <div className="stat"><span className="muted">Connection</span><span style={{ color: status?.online ? "var(--ok)" : "var(--bad)" }}>{status?.online ? "Online" : "Offline"}</span></div>
          <div className="stat"><span className="muted">State</span><span>{status?.machine ?? "–"}</span></div>
          <div className="stat"><span className="muted">Nozzle</span><span>{t?.nozzle ? `${t.nozzle.current.toFixed(0)}° / ${t.nozzle.target.toFixed(0)}°` : "–"}</span></div>
          <div className="stat"><span className="muted">Bed</span><span>{t?.bed ? `${t.bed.current.toFixed(0)}° / ${t.bed.target.toFixed(0)}°` : "–"}</span></div>
          <div className="stat"><span className="muted">Progress</span><span>{status?.online ? `${status.progress ?? 0}%` : "–"}</span></div>
          <div className="stat"><span className="muted">File</span><span className="small">{status?.currentFile || "–"}</span></div>
          {!status?.online && status?.error && <div className="muted small" style={{ marginTop: 6 }}>{status.error}</div>}
        </div>
        <div className="card">
          <h3>Printer</h3>
          <div className="stat"><span className="muted">Model</span><span className="small">{info?.machineType ?? "–"}</span></div>
          <div className="stat"><span className="muted">Firmware</span><span>{info?.firmware ?? "–"}</span></div>
          <div className="stat"><span className="muted">Address</span><span>{settings?.printerHost ?? "–"}</span></div>
          <div className="muted small" style={{ marginTop: 6 }}>Updated {status ? new Date(status.checkedAt).toLocaleTimeString() : "–"}</div>
        </div>
      </aside>
    </div>
  );
}
