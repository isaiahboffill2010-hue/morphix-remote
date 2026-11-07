import { randomUUID } from "node:crypto";

export type ModelSource = "printables" | "thingiverse" | "makerworld" | "other";
export interface SmartModelResult {
  id: string; source: ModelSource; name: string; pageUrl: string; imageUrl: string | null;
  description: string; license: string | null; creator: string | null;
  parts: string[]; nonPrintedParts: string[]; assembly: string[];
  printAsIs: boolean; evidence: string[]; download: "manual" | "thingiverse-api";
}
export interface SmartSearchState { id: string; query: string; status: "searching" | "ready" | "failed"; results: SmartModelResult[]; error?: string; selectedId?: string; }

const ALLOWED = new Map<string, ModelSource>([
  ["www.printables.com", "printables"], ["printables.com", "printables"],
  ["www.thingiverse.com", "thingiverse"], ["thingiverse.com", "thingiverse"],
  ["makerworld.com", "makerworld"], ["www.makerworld.com", "makerworld"],
  ["thangs.com", "other"], ["www.myminifactory.com", "other"], ["cults3d.com", "other"],
]);
const clean = (v: unknown, n = 500) => String(v ?? "").trim().slice(0, n);
const list = (v: unknown, n = 8) => Array.isArray(v) ? v.map((x) => clean(x, 180)).filter(Boolean).slice(0, n) : [];
const attr = (html: string, key: string) => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i").exec(html)?.[1]
    ?? new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i").exec(html)?.[1]
    ?? "";
};

export class SmartModelSearch {
  state: SmartSearchState | null = null;
  constructor(private options: { apiKey?: string; model?: string; thingiverseToken?: string; fetch?: typeof fetch; onChange?: (s: SmartSearchState) => void }) {}
  private update(s: SmartSearchState) { this.state = s; this.options.onChange?.(s); }

  async search(query: string): Promise<SmartSearchState> {
    const q = clean(query, 240); if (!q) throw new Error("Tell me what model to search for.");
    if (!this.options.apiKey) throw new Error("Gemini search is not configured.");
    const id = randomUUID(); this.update({ id, query: q, status: "searching", results: [] });
    try {
      const f = this.options.fetch ?? fetch;
      const prompt = `Find 3 to 5 real, free 3D-printable designs for: ${JSON.stringify(q)}. Search Printables, Thingiverse, MakerWorld and other reputable model libraries. Prefer designs with makes/print evidence. Return ONLY a JSON array. Each item: {name,pageUrl,description,license,creator,parts,nonPrintedParts,assembly,printAsIs,evidence}. pageUrl must be the actual public model page, never a search page or invented URL. Explain bearings, screws, assembly and separate printable parts. Never claim tested without evidence.`;
      const response = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.options.model || "gemini-2.5-flash")}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": this.options.apiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.1 } }),
      });
      if (!response.ok) throw new Error(`Gemini search failed (${response.status})`);
      const body = await response.json() as any;
      const text = body.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
      const raw = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      const candidates = Array.isArray(raw) ? raw : raw.results;
      const results: SmartModelResult[] = [];
      for (const item of Array.isArray(candidates) ? candidates.slice(0, 8) : []) {
        let url: URL; try { url = new URL(clean(item.pageUrl, 1000)); } catch { continue; }
        const source = ALLOWED.get(url.hostname.toLowerCase()); if (!source || url.protocol !== "https:") continue;
        try {
          const page = await f(url, { headers: { "User-Agent": "Morphix/1.0 model-link-verifier" }, redirect: "follow", signal: AbortSignal.timeout(8_000) });
          if (!page.ok || !String(page.headers.get("content-type")).includes("text/html")) continue;
          const html = (await page.text()).slice(0, 1_500_000);
          const canonical = attr(html, "og:url");
          if (canonical) { try { const c = new URL(canonical); if (ALLOWED.has(c.hostname.toLowerCase())) url = c; } catch {} }
          results.push({
            id: randomUUID(), source, name: clean(attr(html, "og:title") || item.name, 120), pageUrl: url.href,
            imageUrl: clean(attr(html, "og:image"), 1200) || null,
            description: clean(item.description || attr(html, "og:description"), 500), license: clean(item.license, 100) || null,
            creator: clean(item.creator, 100) || null, parts: list(item.parts), nonPrintedParts: list(item.nonPrintedParts), assembly: list(item.assembly),
            printAsIs: Boolean(item.printAsIs), evidence: list(item.evidence, 5),
            download: source === "thingiverse" && this.options.thingiverseToken ? "thingiverse-api" : "manual",
          });
        } catch { /* inaccessible pages are never shown */ }
        if (results.length === 5) break;
      }
      if (!results.length) throw new Error("No verified model pages were found. Try different words or use Meshy/CAD.");
      const state = { id, query: q, status: "ready" as const, results }; this.update(state); return state;
    } catch (e) { const state = { id, query: q, status: "failed" as const, results: [], error: (e as Error).message }; this.update(state); return state; }
  }

  select(id: string): SmartModelResult {
    const result = this.state?.results.find((r) => r.id === id); if (!result) throw new Error("That search result is no longer available.");
    this.update({ ...this.state!, selectedId: id }); return result;
  }
}
