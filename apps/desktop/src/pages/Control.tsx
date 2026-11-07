// Control tab: every machine control in one place (light, fan, heating, filament, moving,
// emergency stop). Locked while a print is running — pause it on the Printer tab first.
// Each button still follows the printer's own safety rules (machineCapabilities).
import { useEffect, useState } from "react";
import type { MachineCapability, MachineCommand, PrintControlStatus, PrinterStatus } from "@morphix/shared";
import { api } from "../bridge";

/** Nozzle temperature that counts as "hot enough" to load or unload PLA. */
const FILAMENT_READY_C = 200;
const FILAMENT_HEAT_C = 220;

export function ControlPage({ status, onOpenPrinter, onError }: { status: PrinterStatus | null; onOpenPrinter: () => void; onError: (m: string) => void }) {
  const [control, setControl] = useState<PrintControlStatus | null>(null);
  const [caps, setCaps] = useState<Record<string, MachineCapability>>({});
  const [light, setLight] = useState(false);
  const [fan, setFan] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [filament, setFilament] = useState<"load" | "unload" | null>(null);

  useEffect(() => {
    api.printStatus().then(setControl).catch(() => {});
    const loadCaps = () => api.machineCapabilities().then((list) => setCaps(Object.fromEntries(list.map((c) => [c.command, c])))).catch(() => {});
    void loadCaps();
    const t = window.setInterval(loadCaps, 3000);
    const off = api.onAppEvent((e) => {
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

  const phase = control?.job?.phase;
  const printing = phase === "printing" || status?.machine === "BUILDING_FROM_SD";
  const paused = phase === "paused";
  const locked = !control?.enabled;

  // While printing only the light and the emergency stop stay usable.
  const ALWAYS = new Set(["setLight", "emergencyStop"]);
  const can = (cmd: string) => (printing && !ALWAYS.has(cmd) ? false : (caps[cmd]?.allowedNow ?? false)) && busy === null;
  const why = (cmd: string) => (printing && !ALWAYS.has(cmd) ? "Pause the print first" : caps[cmd] && !caps[cmd].allowedNow ? caps[cmd].reason ?? "Locked" : undefined);

  const run = async (c: MachineCommand, label: string): Promise<boolean> => {
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

  const nozzle = status?.temps?.nozzle;
  const bed = status?.temps?.bed;
  const hot = (nozzle?.current ?? 0) >= FILAMENT_READY_C;

  const startFilament = async (kind: "load" | "unload") => {
    setFilament(kind);
    if (hot || (nozzle?.target ?? 0) >= FILAMENT_READY_C) return;
    if (!can("setNozzleTemp")) {
      onError(`Can't heat the nozzle right now: ${why("setNozzleTemp") ?? "locked"}`);
      return;
    }
    await run({ cmd: "nozzle", celsius: FILAMENT_HEAT_C }, "filament");
  };

  const temp = (t?: { current: number; target: number }) => (t ? `${t.current.toFixed(0)}°${t.target > 0 ? ` → ${t.target.toFixed(0)}°` : ""}` : "–");

  return (
    <div className="settings-grid">
      {(printing || paused || locked) && (
        <div className="card" style={{ gridColumn: "1 / -1", borderColor: printing ? "var(--warn)" : "var(--line)" }}>
          {locked ? (
            <div>🔒 Controls are locked until a grown-up switches them on.</div>
          ) : printing ? (
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <span>🖨️ A print is running. Pause it on the Printer tab to use these controls (the light and emergency stop always work).</span>
              <button className="btn" style={{ minHeight: 44 }} onClick={onOpenPrinter}>Go to Printer</button>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <span>⏸️ The print is paused. Controls that are safe during a pause are on. Resume or end it on the Printer tab.</span>
              <button className="btn" style={{ minHeight: 44 }} onClick={onOpenPrinter}>Go to Printer</button>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3>🔥 Heat</h3>
        <div className="stat"><span className="muted">Nozzle</span><span>{temp(nozzle)}</span></div>
        <div className="stat"><span className="muted">Bed</span><span>{temp(bed)}</span></div>
        <div className="ctl-grid" style={{ marginTop: 8 }}>
          <button className="ctl" disabled={!can("setNozzleTemp")} title={why("setNozzleTemp")}
            onClick={async () => { if (confirm("Heat up for PLA? (nozzle 210 °C, bed 60 °C) — it gets HOT!")) { if (await run({ cmd: "bed", celsius: 60 }, "heat")) await run({ cmd: "nozzle", celsius: 210 }, "heat"); } }}>
            <span className="emoji">🔥</span>Heat for PLA
          </button>
          <button className="ctl" disabled={!can("setNozzleTemp")} title={why("setNozzleTemp")}
            onClick={() => { if (confirm("Heat only the nozzle to 210 °C?")) void run({ cmd: "nozzle", celsius: 210 }, "nozzle"); }}>
            <span className="emoji">🖊️</span>Nozzle 210°
          </button>
          <button className="ctl" disabled={!can("setBedTemp")} title={why("setBedTemp")}
            onClick={() => { if (confirm("Heat only the bed to 60 °C?")) void run({ cmd: "bed", celsius: 60 }, "bed"); }}>
            <span className="emoji">🟧</span>Bed 60°
          </button>
          <button className="ctl" disabled={!can("coolDown")} title={why("coolDown")} onClick={() => void run({ cmd: "cooldown" }, "cool")}>
            <span className="emoji">❄️</span>Cool down
          </button>
        </div>
      </div>

      <div className="card">
        <h3>🧵 Filament</h3>
        {filament === null ? (
          <>
            <div className="ctl-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <button className="ctl" disabled={printing || locked || busy !== null} title={printing ? "Pause the print first" : undefined} onClick={() => void startFilament("load")}>
                <span className="emoji">⬇️</span>Load filament
              </button>
              <button className="ctl" disabled={printing || locked || busy !== null} title={printing ? "Pause the print first" : undefined} onClick={() => void startFilament("unload")}>
                <span className="emoji">⬆️</span>Unload filament
              </button>
            </div>
            <div className="muted small" style={{ marginTop: 6 }}>Heats the nozzle to {FILAMENT_HEAT_C} °C, then tells you what to do.</div>
          </>
        ) : (
          <div>
            <div style={{ fontWeight: 700 }}>{filament === "load" ? "Loading filament" : "Unloading filament"}</div>
            {!hot ? (
              <>
                <div className="progress" style={{ margin: "8px 0" }}>
                  <div style={{ width: `${Math.min(100, Math.round(((nozzle?.current ?? 0) / FILAMENT_READY_C) * 100))}%` }} />
                </div>
                <div className="small">Heating the nozzle… {nozzle ? `${nozzle.current.toFixed(0)} °C` : ""} (needs {FILAMENT_READY_C} °C). Don't touch the nozzle — it gets very hot!</div>
              </>
            ) : (
              <div className="small" style={{ marginTop: 6 }}>
                ✅ Hot and ready. On the <b>printer's own screen</b> choose <b>Filament → {filament === "load" ? "Load" : "Unload"}</b> to run the feeder
                {filament === "load" ? ", and push the filament in until plastic comes out of the nozzle." : ", then pull the filament out gently."}
                <div className="muted" style={{ marginTop: 4 }}>Morphix can heat the nozzle, but the printer doesn't let it run the feeder motor over the network.</div>
              </div>
            )}
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              <button className="btn" style={{ minHeight: 44 }} onClick={() => setFilament(null)}>Done</button>
              <button className="btn ghost" style={{ minHeight: 44 }} disabled={!can("coolDown")} title={why("coolDown")}
                onClick={async () => { if (await run({ cmd: "cooldown" }, "cool")) setFilament(null); }}>Done — cool down</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>💡 Light & fan</h3>
        <div className="ctl-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <button className={`ctl ${light ? "on" : ""}`} disabled={!can("setLight")} title={why("setLight")}
            onClick={async () => { if (await run({ cmd: "light", on: !light }, "light")) setLight(!light); }}>
            <span className="emoji">💡</span>Light {light ? "on" : "off"}
          </button>
          <button className={`ctl ${fan ? "on" : ""}`} disabled={!can("setFan")} title={why("setFan")}
            onClick={async () => { if (await run({ cmd: "fan", percent: fan ? 0 : 100 }, "fan")) setFan(!fan); }}>
            <span className="emoji">🌀</span>Fan {fan ? "on" : "off"}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>🏠 Move</h3>
        <div className="ctl-grid">
          <button className="ctl" disabled={!can("home")} title={why("home")} onClick={() => void run({ cmd: "home" }, "home")}>
            <span className="emoji">🏠</span>Home
          </button>
          <button className="ctl" disabled={!can("motorsOff")} title={why("motorsOff")} onClick={() => void run({ cmd: "motorsOff" }, "motors")}>
            <span className="emoji">🔓</span>Motors off
          </button>
          <button className="ctl danger" disabled={!can("emergencyStop")} title={why("emergencyStop")}
            onClick={() => { if (confirm("Emergency stop? This ends any print and turns the heaters off.")) void run({ cmd: "stop" }, "stop"); }}>
            <span className="emoji">🛑</span>Emergency stop
          </button>
        </div>
      </div>

      {(busy || message) && (
        <div className="muted small" style={{ gridColumn: "1 / -1" }}>{busy ? "Working on it…" : message}</div>
      )}
    </div>
  );
}
