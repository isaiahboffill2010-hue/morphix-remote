import { describe, expect, it } from "vitest";
import { SmartModelSearch } from "@morphix/model-search";

describe("SmartModelSearch", () => {
  it("keeps only reachable real model pages and preserves assembly facts", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input); calls.push(url);
      if (url.includes("generativelanguage")) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify([
        { name: "Bearing spinner", pageUrl: "https://www.printables.com/model/123-bearing-spinner", description: "Three arm spinner", license: "CC BY", creator: "Maker", parts: ["body", "caps"], nonPrintedParts: ["608 bearing"], assembly: ["Press bearing into body"], printAsIs: false, evidence: ["creator shows a completed make"] },
        { name: "Invented", pageUrl: "https://evil.example/fake", description: "fake" },
      ]) }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response('<meta property="og:title" content="Real Bearing Spinner"><meta property="og:image" content="https://media.printables.com/spinner.jpg"><meta property="og:url" content="https://www.printables.com/model/123-bearing-spinner">', { status: 200, headers: { "content-type": "text/html" } });
    };
    const search = new SmartModelSearch({ apiKey: "key", fetch: fakeFetch });
    const state = await search.search("working fidget spinner");
    expect(state.status).toBe("ready"); expect(state.results).toHaveLength(1);
    expect(state.results[0]).toMatchObject({ name: "Real Bearing Spinner", source: "printables", nonPrintedParts: ["608 bearing"], download: "manual", printAsIs: false });
    expect(calls.some((x) => x.includes("evil.example"))).toBe(false);
  });

  it("never returns unverified or inaccessible candidates", async () => {
    const fakeFetch: typeof fetch = async (input) => String(input).includes("generativelanguage")
      ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '[{"name":"x","pageUrl":"https://thingiverse.com/thing:1"}]' }] } }] }), { status: 200 })
      : new Response("blocked", { status: 403 });
    const state = await new SmartModelSearch({ apiKey: "key", fetch: fakeFetch }).search("x");
    expect(state.status).toBe("failed"); expect(state.results).toEqual([]);
  });
});
