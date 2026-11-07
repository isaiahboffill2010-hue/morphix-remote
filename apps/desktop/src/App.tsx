import { Component, useEffect, useState, type ReactNode } from "react";
import type { AppSettings, PrinterStatus } from "@morphix/shared";
import { api } from "./bridge";
import { AssistantPage } from "./pages/Assistant";
import { LibraryPage } from "./pages/Library";
import { ViewerPage } from "./pages/Viewer";
import { PrinterPage } from "./pages/Printer";
import { SettingsPage } from "./pages/Settings";

export type Page = "assistant" | "library" | "viewer" | "printer" | "settings";

const ICONS: Record<Page, ReactNode> = {
  assistant: <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3" />,
  library: <path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z" />,
  viewer: <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 0v20M3 7l9 5 9-5" />,
  printer: <path d="M6 9V3h12v6M6 18H4v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7h-2M8 14h8v7H8z" />,
  settings: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" />,
};
const LABELS: Record<Page, string> = { assistant: "Create", library: "Library", viewer: "Viewer", printer: "Printer", settings: "Settings" };

/** Keeps one failing page from blanking the whole kiosk. */
class PageBoundary extends Component<{ children: ReactNode; page: string }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  componentDidCatch(e: Error) {
    api.log("error", `page ${this.props.page} crashed: ${e.message}`);
  }
  componentDidUpdate(prev: { page: string }) {
    if (prev.page !== this.props.page && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty">
        <div>
          <div style={{ fontSize: 20, fontWeight: 650 }}>This screen hit a problem</div>
          <div className="muted small" style={{ margin: "6px 0 12px" }}>{this.state.error}</div>
          <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    );
  }
}

export function App() {
  const [page, setPage] = useState<Page>("assistant");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [printer, setPrinter] = useState<PrinterStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.printerStatus().then(setPrinter);
    return api.onPrinterStatus(setPrinter);
  }, []);

  const openProject = (id: string) => {
    setProjectId(id);
    setPage("viewer");
  };

  const pDot = !printer ? "" : printer.online ? (printer.machine === "READY" ? "ok" : "warn") : "bad";
  const pText = !printer ? "Printer…" : printer.online ? `QD330 · ${(printer.machine ?? "online").replaceAll("_", " ").toLowerCase()}` : "QD330 offline";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span>Morphix</span></div>
        <span className="spacer" />
        {settings?.demoMode && <span className="chip"><span className="dot warn" />Demo AI</span>}
        <span className="chip"><span className={`dot ${pDot}`} />{pText}</span>
      </header>
      <nav className="rail">
        {(Object.keys(LABELS) as Page[]).map((p) => (
          <button key={p} className={page === p ? "active" : ""} onClick={() => setPage(p)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{ICONS[p]}</svg>
            {LABELS[p]}
          </button>
        ))}
      </nav>
      <main className="content">
        <PageBoundary page={page}>
        {page === "assistant" && <AssistantPage onOpenProject={openProject} />}
        {page === "library" && <LibraryPage onOpen={openProject} />}
        {page === "viewer" && <ViewerPage projectId={projectId} onBrowse={() => setPage("library")} />}
        {page === "printer" && <PrinterPage status={printer} settings={settings} />}
        {page === "settings" && <SettingsPage settings={settings} />}
        </PageBoundary>
      </main>
    </div>
  );
}
