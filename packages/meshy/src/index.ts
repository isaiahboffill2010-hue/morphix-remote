// 3D generation adapters. Phase 1 ships the demo adapter (procedural geometry,
// no network, no cost). The Meshy adapter is wired in Phase 2 behind the same interface.

export interface GenerationUpdate {
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  stage: string;
}

export interface GeneratedModel {
  format: "stl" | "glb";
  data: Buffer;
  /** Remote id when the provider has one (Meshy task id). */
  remoteId?: string;
}

export interface ModelGenerator {
  readonly name: "demo" | "meshy";
  generate(prompt: string, onUpdate: (u: GenerationUpdate) => void, signal?: AbortSignal): Promise<GeneratedModel>;
}

export class MeshyNotConfigured extends Error {
  constructor() {
    super("Meshy is not enabled yet (Phase 2). Add MESHY_API_KEY and enable it in a later phase.");
  }
}

// ---------------------------------------------------------------------------
// Demo adapter: honest about being a demo — stages are labelled as such.

type Shape = "vase" | "torus" | "star" | "gear";

export function pickShape(prompt: string): Shape {
  const p = prompt.toLowerCase();
  if (/\b(vase|cup|pot|bowl)\b/.test(p)) return "vase";
  if (/\b(ring|donut|torus|bracelet)\b/.test(p)) return "torus";
  if (/\b(star|trophy|badge)\b/.test(p)) return "star";
  if (/\b(gear|cog|wheel)\b/.test(p)) return "gear";
  const shapes: Shape[] = ["vase", "torus", "star", "gear"];
  let h = 0;
  for (const c of p) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return shapes[h % shapes.length];
}

export class DemoGenerator implements ModelGenerator {
  readonly name = "demo" as const;

  constructor(private stepMs = 700) {}

  async generate(prompt: string, onUpdate: (u: GenerationUpdate) => void, signal?: AbortSignal): Promise<GeneratedModel> {
    const stages = ["Demo: queued", "Demo: shaping", "Demo: building mesh", "Demo: finishing"];
    onUpdate({ status: "queued", progress: 0, stage: stages[0] });
    for (let i = 1; i <= 8; i++) {
      await sleep(this.stepMs, signal);
      onUpdate({ status: "running", progress: i * 12, stage: stages[Math.min(3, Math.floor(i / 2.2))] });
    }
    const tris = buildShape(pickShape(prompt));
    onUpdate({ status: "succeeded", progress: 100, stage: "Demo: done" });
    return { format: "stl", data: toBinaryStl(tris, `Morphix demo: ${prompt}`) };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("cancelled"));
    });
  });
}

// ---------------------------------------------------------------------------
// Procedural meshes (millimetres, Z up, sitting on Z=0). All closed/watertight.

type V = [number, number, number];
export type Tri = [V, V, V];

/** Surface of revolution from a profile of (radius, z) points, capped top and bottom. */
function lathe(profile: [number, number][], segments: number): Tri[] {
  const tris: Tri[] = [];
  const ring = (r: number, z: number, k: number): V => {
    const a = (2 * Math.PI * k) / segments;
    return [r * Math.cos(a), r * Math.sin(a), z];
  };
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, z0] = profile[i];
    const [r1, z1] = profile[i + 1];
    for (let k = 0; k < segments; k++) {
      const a = ring(r0, z0, k), b = ring(r0, z0, k + 1), c = ring(r1, z1, k + 1), d = ring(r1, z1, k);
      tris.push([a, b, c], [a, c, d]);
    }
  }
  const [rb, zb] = profile[0];
  const [rt, zt] = profile[profile.length - 1];
  for (let k = 0; k < segments; k++) {
    tris.push([[0, 0, zb], ring(rb, zb, k + 1), ring(rb, zb, k)]);
    tris.push([[0, 0, zt], ring(rt, zt, k), ring(rt, zt, k + 1)]);
  }
  return tris;
}

function vase(): Tri[] {
  const profile: [number, number][] = [];
  for (let i = 0; i <= 24; i++) {
    const z = (i / 24) * 80;
    const r = 18 + 10 * Math.sin((i / 24) * Math.PI * 1.3) - (i > 20 ? (i - 20) * 1.5 : 0);
    profile.push([r, z]);
  }
  return lathe(profile, 48);
}

function torus(): Tri[] {
  const R = 30, r = 10, nu = 48, nv = 24;
  const p = (u: number, v: number): V => {
    const a = (2 * Math.PI * u) / nu, b = (2 * Math.PI * v) / nv;
    return [(R + r * Math.cos(b)) * Math.cos(a), (R + r * Math.cos(b)) * Math.sin(a), r + r * Math.sin(b)];
  };
  const tris: Tri[] = [];
  for (let u = 0; u < nu; u++)
    for (let v = 0; v < nv; v++) {
      const a = p(u, v), b = p(u + 1, v), c = p(u + 1, v + 1), d = p(u, v + 1);
      tris.push([a, b, c], [a, c, d]);
    }
  return tris;
}

/** Extrude a closed 2D outline (counter-clockwise, star-shaped around origin) to height h. */
function extrude(outline: [number, number][], h: number): Tri[] {
  const tris: Tri[] = [];
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % n];
    tris.push([[x0, y0, 0], [x1, y1, 0], [x1, y1, h]], [[x0, y0, 0], [x1, y1, h], [x0, y0, h]]);
    tris.push([[0, 0, 0], [x1, y1, 0], [x0, y0, 0]]);
    tris.push([[0, 0, h], [x0, y0, h], [x1, y1, h]]);
  }
  return tris;
}

function star(): Tri[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI * 2 * i) / 10 + Math.PI / 2;
    const r = i % 2 === 0 ? 45 : 19;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return extrude(pts, 12);
}

function gear(): Tri[] {
  const pts: [number, number][] = [];
  const teeth = 16;
  for (let i = 0; i < teeth * 4; i++) {
    const a = (Math.PI * 2 * i) / (teeth * 4);
    const r = i % 4 < 2 ? 40 : 33;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return extrude(pts, 10);
}

export function buildShape(shape: Shape): Tri[] {
  return { vase, torus, star, gear }[shape]();
}

export function toBinaryStl(tris: Tri[], header = "Morphix"): Buffer {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write(header.slice(0, 79), 0, "ascii");
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    for (const x of [n[0] / len, n[1] / len, n[2] / len, ...a, ...b, ...c]) {
      buf.writeFloatLE(x, o);
      o += 4;
    }
    buf.writeUInt16LE(0, o);
    o += 2;
  }
  return buf;
}
