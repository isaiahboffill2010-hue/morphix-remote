// Push-to-talk capture: microphone -> AudioWorklet -> 16 kHz mono 16-bit PCM
// (the format Gemini Live expects in Phase 2).
export const TARGET_RATE = 16000;

export class PushToTalk {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private chunks: Float32Array[] = [];

  constructor(private onLevel: (level: number) => void = () => {}) {}

  get active(): boolean {
    return this.ctx !== null;
  }

  async start(): Promise<void> {
    if (this.ctx) return;
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule("./pcm-recorder.worklet.js");
    const src = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, "pcm-recorder");
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this.chunks.push(e.data);
      let peak = 0;
      for (const s of e.data) peak = Math.max(peak, Math.abs(s));
      this.onLevel(Math.min(1, peak * 2));
    };
    // The worklet must be pulled by the destination to run; route it through a muted gain.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(this.ctx.destination);
  }

  async stop(): Promise<{ pcm: ArrayBuffer; sampleRate: number; seconds: number }> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("not recording");
    const rate = ctx.sampleRate;
    this.stream?.getTracks().forEach((t) => t.stop());
    await ctx.close();
    this.ctx = null;
    this.stream = null;
    this.onLevel(0);
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    const pcm = toPcm16(downsample(all, rate, TARGET_RATE));
    return { pcm: pcm.buffer as ArrayBuffer, sampleRate: TARGET_RATE, seconds: pcm.length / TARGET_RATE };
  }
}

export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

export function toPcm16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Short two-tone chime to check the speaker. */
export async function speakerTest(): Promise<void> {
  const ctx = new AudioContext();
  const t = ctx.currentTime;
  for (const [freq, at] of [[660, 0], [880, 0.18]] as const) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t + at);
    g.gain.exponentialRampToValueAtTime(0.3, t + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.3);
    osc.connect(g).connect(ctx.destination);
    osc.start(t + at);
    osc.stop(t + at + 0.32);
  }
  await new Promise((r) => setTimeout(r, 700));
  await ctx.close();
}

/** Plays streamed 16-bit PCM (Gemini speaks at 24 kHz) gap-free through the speaker. */
export class AudioOut {
  private ctx: AudioContext | null = null;
  private next = 0;
  private sources = new Set<AudioBufferSourceNode>();

  play(pcm: ArrayBuffer, sampleRate: number): void {
    if (!this.ctx) this.ctx = new AudioContext();
    const ctx = this.ctx;
    const ints = new Int16Array(pcm);
    if (!ints.length) return;
    const buf = ctx.createBuffer(1, ints.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ints.length; i++) ch[i] = ints[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    this.next = Math.max(this.next, ctx.currentTime + 0.05);
    src.start(this.next);
    this.next += buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  get playing(): boolean {
    return this.sources.size > 0;
  }

  /** Stop immediately (user started talking or Gemini was interrupted). */
  stop(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.next = 0;
  }
}
