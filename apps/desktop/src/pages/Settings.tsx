import { useEffect, useState } from "react";
import type { AppSettings, SystemInfo } from "@morphix/shared";
import { api } from "../bridge";
import { speakerTest } from "../audio";

const KEY_LABELS: Record<keyof AppSettings["keys"], string> = {
  gemini: "Gemini", meshy: "Meshy", vultr: "Vultr", tiger: "Tiger Data", swarms: "Swarms", auth0: "Auth0",
};

export function SettingsPage({ settings }: { settings: AppSettings | null }) {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const refresh = () => {
    api.getSystemInfo().then(setSys);
    api.recentLogs(80).then(setLogs);
  };
  useEffect(refresh, []);

  const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;
  return (
    <div className="settings">
      <div className="card">
        <h3>Storage</h3>
        <div className="stat"><span className="muted">Location</span><span className="small">{sys?.storageRoot ?? "–"}</span></div>
        <div className="stat"><span className="muted">Free space</span><span>{sys ? `${gb(sys.freeBytes)} of ${gb(sys.totalBytes)}` : "–"}</span></div>
        <div className="stat"><span className="muted">App version</span><span>{sys?.version ?? "–"} · {sys?.arch}</span></div>
      </div>
      <div className="card">
        <h3>AI services</h3>
        {settings &&
          (Object.keys(KEY_LABELS) as (keyof AppSettings["keys"])[]).map((k) => (
            <div className="stat" key={k}>
              <span className="muted">{KEY_LABELS[k]}</span>
              <span style={{ color: settings.keys[k] ? "var(--ok)" : "var(--muted)" }}>{settings.keys[k] ? "Key present" : "Not configured"}</span>
            </div>
          ))}
        <div className="muted small" style={{ marginTop: 6 }}>Keys go in {settings?.storageRoot}/config/morphix.env on the Pi. They never reach this screen.</div>
      </div>
      <div className="card">
        <h3>Audio</h3>
        <div className="row">
          <button className="btn" onClick={() => void speakerTest()}>Test speaker</button>
          <span className="muted small">Mic test: hold the button on the Create page, then play it back.</span>
        </div>
      </div>
      <div className="card">
        <h3>Printer</h3>
        <div className="stat"><span className="muted">Address</span><span>{settings?.printerHost}</span></div>
        <div className="stat"><span className="muted">Status poll</span><span>every {settings?.printerPollSeconds}s</span></div>
        <div className="stat"><span className="muted">Print controls</span><span style={{ color: "var(--warn)" }}>Disabled (observation only)</span></div>
      </div>
      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Recent log</h3>
          <button className="btn ghost" style={{ minHeight: 40 }} onClick={refresh}>Refresh</button>
        </div>
        <div className="logs">{logs.join("\n") || "No log entries yet."}</div>
      </div>
    </div>
  );
}
