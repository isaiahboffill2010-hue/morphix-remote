import { useEffect, useState } from "react";
import type { AppSettings, GuardianView, MachineCapability, MachineCommand, PrintControlStatus, PrinterStatus } from "@morphix/shared";
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
  const [caps, setCaps] = useState<Record<string, MachineCapability>>({});
  const [light, setLight] = useState(false);
  const [fan, setFan] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.guardian().then(setGuardian);
    api.printStatus().then(setControl);
    const loadCaps = () => api.machineCapabilities().then((list) => setCaps(Object.fromEntries(list.map((c) => [c.command, c])))).catch(() => {});
    void loadCaps();
    const t = window.setInterval(loadCaps, 5000);
    const off = api.onAppEvent((e) => {
      if (e.type === "guardian") setGuardian(e.snapshot);
      if (e.type === "print-status") setControl(e.status);
    });
    return () => {
      window.clearInterval(t);
      off();
    };
  }, []);

  useEffect(() => {
    if (status?.online && typeof (status as { led?: unknown }).led !== "undefined") setLight(String((status as { led?: unknown }).led) === "1");
  }, [status]);

  const machine = async (c: MachineCommand, label: string) => {
    setBusy(label);
    try {
      const r = await api.machineCommand(c);
      setMessage(r.message);
      if (!r.ok) onError(r.code ? `${r.code}|${r.message}||` : r.message);
      return r.ok;
    } catch (e) {
      onError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const can = (cmd: string) => caps[cmd]?.allowedNow ?? false;
  const why = (cmd: string) => (caps[cmd] && !caps[cmd].allowedNow ? caps[cmd].reason ?? "Locked" : undefined);

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
            <h3>Printing now 🖨️</h3>
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
          <h3>Controls</h3>
          <div className="ctl-grid">
            <button className={`ctl ${light ? "on" : ""}`} disabled={!can("setLight") || busy !== null} title={why("setLight")}
              onClick={async () => { if (await machine({ cmd: "light", on: !light }, "light")) setLight(!light); }}>
              <span className="emoji">💡</span>Light
            </button>
            <button className={`ctl ${fan ? "on" : ""}`} disabled={!can("setFan") || busy !== null} title={why("setFan")}
              onClick={async () => { if (await machine({ cmd: "fan", percent: fan ? 0 : 100 }, "fan")) setFan(!fan); }}>
              <span className="emoji">🌀</span>Fan
            </button>
            <button className="ctl" disabled={!can("home") || busy !== null} title={why("home")} onClick={() => void machine({ cmd: "home" }, "home")}>
              <span className="emoji">🏠</span>Home
            </button>
            <button className="ctl" disabled={!can("setNozzleTemp") || busy !== null} title={why("setNozzleTemp")}
              onClick={async () => { if (confirm("Heat up for PLA? (nozzle 210 °C, bed 60 °C) — it gets HOT!")) { await machine({ cmd: "bed", celsius: 60 }, "heat"); await machine({ cmd: "nozzle", celsius: 210 }, "heat"); } }}>
              <span className="emoji">🔥</span>Heat up
            </button>
            <button className="ctl" disabled={!can("coolDown") || busy !== null} title={why("coolDown")} onClick={() => void machine({ cmd: "cooldown" }, "cool")}>
              <span className="emoji">❄️</span>Cool down
            </button>
            <button className="ctl danger" disabled={!can("emergencyStop") || busy !== null} title={why("emergencyStop")}
              onClick={() => { if (confirm("Stop the printer now?")) void machine({ cmd: "stop" }, "stop"); }}>
              <span className="emoji">🛑</span>Stop
            </button>
          </div>
          {!control?.enabled && <div className="muted small" style={{ marginTop: 6 }}>🔒 Controls are locked until a grown-up switches them on.</div>}
          {busy && <div className="muted small" style={{ marginTop: 6 }}>Working on it…</div>}
        </div>
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>🛡️ Print Guardian</h3>
            <button className="btn" style={{ minHeight: 40 }} onClick={() => void g(guardian?.running ? "stop" : "start")}>{guardian?.running ? "Stop" : "Watch my print"}</button>
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
