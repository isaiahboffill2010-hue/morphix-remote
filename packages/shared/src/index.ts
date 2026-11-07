// Types and the IPC contract shared by the Electron main process and the React renderer.
import type { WorkflowState } from "@morphix/domain";

export type { WorkflowState };

export interface Project {
  id: string;
  title: string;
  prompt: string;
  state: WorkflowState;
  createdAt: string;
  updatedAt: string;
  latestVersionId: string | null;
  thumbnailUrl: string | null;
}

export interface ModelVersion {
  id: string;
  projectId: string;
  version: number;
  source: "demo" | "meshy" | "openscad" | "scan";
  kind: "demo" | "preview" | "refine";
  format: "stl" | "glb";
  /** URL the renderer can load (served by the local app server). */
  url: string;
  /** Printable STL for this version, when one exists. */
  stlUrl: string | null;
  thumbnailUrl: string | null;
  bytes: number;
  targetHeightMm: number | null;
  createdAt: string;
}

export interface GenerationProgress {
  taskId: string;
  projectId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  stage: string;
  error?: string;
  versionId?: string;
  thumbnailUrl?: string;
  kind?: "preview" | "refine" | "demo";
}

export interface PrinterTemps {
  nozzle?: { current: number; target: number };
  bed?: { current: number; target: number };
}

export interface PrinterStatus {
  online: boolean;
  checkedAt: string;
  error?: string;
  machine?: string;
  moveMode?: string;
  currentFile?: string;
  temps?: PrinterTemps;
  position?: Record<string, number>;
  progress?: number;
  layer?: [number, number];
}

export interface PrinterInfo {
  machineType?: string;
  machineName?: string;
  firmware?: string;
  serial?: string;
  buildVolume?: string;
}

export interface AssistantTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  audioUrl?: string;
  createdAt: string;
}

export interface RecordingResult {
  turn: AssistantTurn;
  reply: AssistantTurn;
  /** When the assistant proposes generating a model, the prompt it would send. */
  proposedPrompt?: string;
}

export interface AiStatus {
  assistant: "gemini-live" | "missing";
  geminiModel: string;
  generator: "meshy" | "missing";
  meshyModel: string;
  previewCredits: number;
  refineCredits: number;
  dailyLimit: number;
  usedToday: number;
}

export interface AppSettings {
  storageRoot: string;
  ai: AiStatus;
  printerHost: string;
  cameraStreamUrl: string;
  cameraSnapshotUrl: string;
  printerPollSeconds: number;
  demoMode: boolean;
  keys: Record<"gemini" | "meshy" | "vultr" | "tiger" | "swarms" | "auth0", boolean>;
  printControlsEnabled: false;
}

export interface SystemInfo {
  version: string;
  platform: string;
  arch: string;
  storageRoot: string;
  freeBytes: number;
  totalBytes: number;
  logFile: string;
  uptimeSeconds: number;
}

/** An action that costs money or changes things; waits for the user's explicit OK. */
export interface PendingAction {
  id: string;
  kind: "generate" | "refine" | "print";
  /** Print jobs: the prepared job and the file that will be sent. */
  jobId?: string;
  fileName?: string;
  details?: string[];
  title: string;
  prompt: string;
  projectId: string | null;
  versionId: string | null;
  credits: number;
  createdAt: string;
}

export type VoiceEvent =
  | { type: "status"; state: "connecting" | "ready" | "thinking" | "speaking" | "idle" | "offline" }
  | { type: "user-text"; text: string }
  | { type: "assistant-text"; text: string }
  | { type: "audio"; pcm: ArrayBuffer; sampleRate: number }
  | { type: "interrupted" }
  /** A Print Guardian warning is about to be spoken: play the alert chime. */
  | { type: "alert" }
  | { type: "turn-complete"; user: AssistantTurn | null; assistant: AssistantTurn | null }
  | { type: "error"; message: string };

export type AppEvent =
  | { type: "pending"; action: PendingAction | null }
  | { type: "navigate"; page: "viewer" | "library" | "assistant" | "prepare" | "printer"; projectId?: string }
  | { type: "model-height"; versionId: string; heightMm: number }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string; code?: string; hint?: string }
  | { type: "job"; job: JobView }
  | { type: "prepare-progress"; jobId: string; stage: string }
  | { type: "print-status"; status: PrintControlStatus }
  | { type: "guardian"; snapshot: GuardianView };

/** Progress of one pipeline (text→print, photo→print, prepare, print) for the progress bar. */
export interface JobView {
  id: string;
  kind: string;
  title: string;
  status: string;
  percent: number;
  currentStage: string | null;
  stages: { key: string; label: string; status: string; progress: number; detail?: string }[];
  error?: { code: string; title: string; hint: string } | null;
  updatedAt: string;
}

export type MachineCommand =
  | { cmd: "light"; on: boolean }
  | { cmd: "fan"; percent: number }
  | { cmd: "home" }
  | { cmd: "nozzle"; celsius: number }
  | { cmd: "bed"; celsius: number }
  | { cmd: "cooldown" }
  | { cmd: "motorsOff" }
  | { cmd: "stop" };

export interface MachineCapability {
  command: string;
  verified: boolean;
  enabled: boolean;
  allowedNow: boolean;
  reason?: string;
}

export interface PrepareSettings {
  layerHeightMm: number;
  infillPercent: number;
  supports: "none" | "auto" | "buildplate";
}

export interface PrepareAdvice {
  slicer: string | null;
  layerHeightMm: number;
  infillPercent: number;
  supports: string;
  brim: boolean;
  reasons: string[];
  warnings: string[];
  source: "heuristic" | "gemini";
}

export interface PrepareSummary {
  jobId: string;
  projectId: string;
  versionId: string;
  createdAt: string;
  settings: PrepareSettings;
  ok: boolean;
  error?: string;
  size?: { x: number; y: number; z: number };
  fits?: boolean;
  upAxis?: string;
  repairs: string[];
  issues: string[];
  warnings: string[];
  slicer: { ok: boolean; name?: string; reason?: string; message?: string };
  estimates?: { printTimeS: number | null; filamentG: number | null; filamentMm: number | null; layerCount: number | null; source: string };
  gx: { ok: boolean; verified: boolean; fileName?: string; bytes?: number; reason?: string };
  previewUrl?: string | null;
  advice?: PrepareAdvice;
  errorCode?: string;
}

export interface PrintControlStatus {
  /** Printer control switched on by the operator (MORPHIX_PRINT_CONTROLS=1). */
  enabled: boolean;
  /** Generated .gx files may be sent (MORPHIX_GX_VERIFIED=1 after comparing with Afinia output). */
  gxVerified: boolean;
  job: { jobId?: string; fileName?: string; phase: string; progress: number; layer: [number, number]; recovered: boolean; offline: boolean } | null;
  busy: string | null;
  lastMessage: string | null;
}

/** Plain-JSON view of the AI Print Guardian for the UI. */
export interface GuardianView {
  running: boolean;
  state: string;
  label: string;
  camera: string;
  cameraDetail?: string;
  worker: string;
  alert: { id: string; kind: string; state: string; score: number; openedAt: string; evidenceUrls: string[]; explanation?: string } | null;
  gemini: boolean;
  autoPause: boolean;
  pauseAvailable: boolean;
  /** Spoken warning waiting for "stop" / "keep printing" (voice or touch). */
  voice?: GuardianVoiceView | null;
}

export interface GuardianVoiceView {
  alertId: string;
  kind: string;
  problem: string;
  announcements: number;
  awaitingAnswer: boolean;
  lastSpokenBy: "gemini" | "local" | "none" | null;
  /** A test from Grown-ups: no printer commands are ever sent. */
  simulated: boolean;
}

export interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
  inUse: boolean;
  saved: boolean;
}

export interface NetworkStatus {
  hostname: string;
  wifi: { device: string; state: string; ssid: string | null; ip: string | null; signal: number | null } | null;
  ethernet: { device: string; state: string; connection: string | null; ip: string | null } | null;
}

/** Everything the renderer may call. Exposed by preload as window.morphix. */
export interface MorphixApi {
  getSettings(): Promise<AppSettings>;
  getSystemInfo(): Promise<SystemInfo>;
  recentLogs(lines?: number): Promise<string[]>;
  log(level: "info" | "warn" | "error", message: string): void;

  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<{ project: Project; versions: ModelVersion[] } | null>;
  createProjectFromPrompt(prompt: string): Promise<{ project: Project; taskId: string } | { pending: PendingAction }>;
  setTargetHeight(versionId: string, heightMm: number | null): Promise<ModelVersion>;
  saveThumbnail(versionId: string, pngDataUrl: string): Promise<void>;
  onGenerationProgress(cb: (p: GenerationProgress) => void): () => void;

  submitRecording(pcm16: ArrayBuffer, sampleRate: number): Promise<RecordingResult>;
  sendText(text: string): Promise<RecordingResult>;
  conversation(): Promise<AssistantTurn[]>;

  printerStatus(): Promise<PrinterStatus>;
  printerInfo(): Promise<PrinterInfo>;
  onPrinterStatus(cb: (s: PrinterStatus) => void): () => void;

  /** Live voice (Gemini): send one push-to-talk utterance; replies stream via onVoiceEvent. */
  voiceTurn(pcm16: ArrayBuffer, sampleRate: number): Promise<void>;
  voiceText(text: string): Promise<void>;
  onVoiceEvent(cb: (e: VoiceEvent) => void): () => void;
  onAppEvent(cb: (e: AppEvent) => void): () => void;
  pendingAction(): Promise<PendingAction | null>;
  confirmAction(id: string): Promise<void>;
  cancelAction(id: string): Promise<void>;
  requestRefine(versionId: string): Promise<void>;
  meshyBalance(): Promise<{ balance: number } | { error: string }>;
  testGemini(): Promise<{ ok: boolean; message: string }>;

  /** settings "auto" = let the AI slicer advisor choose. */
  preparePrint(versionId: string, settings: PrepareSettings | "auto"): Promise<PrepareSummary>;
  machineCommand(command: MachineCommand): Promise<{ ok: boolean; message: string; code?: string }>;
  machineCapabilities(): Promise<MachineCapability[]>;
  jobs(): Promise<JobView[]>;
  portalInfo(): Promise<{ running: boolean; url: string | null; authConfigured: boolean; missing: string[] }>;
  latestPrintJob(projectId: string): Promise<PrepareSummary | null>;
  requestPrint(jobId: string): Promise<void>;
  printStatus(): Promise<PrintControlStatus>;
  pausePrint(): Promise<{ ok: boolean; message: string }>;
  cancelPrint(): Promise<{ ok: boolean; message: string }>;
  guardian(): Promise<GuardianView>;
  guardianCommand(cmd: "start" | "stop" | "requestPause" | "resolve" | "dismiss" | "resetBaseline"): Promise<GuardianView>;
  /** Answer the spoken print warning: same as saying "yes, stop it" / "no, keep printing". */
  guardianAnswer(decision: "stop" | "keep"): Promise<{ ok: boolean; message: string }>;
  /** Speak a pretend warning to test audio and answers. Never sends printer commands. */
  guardianSimulate(): Promise<{ ok: boolean; message: string }>;

  networkStatus(): Promise<NetworkStatus>;
  wifiScan(): Promise<WifiNetwork[]>;
  wifiConnect(ssid: string, password: string | null): Promise<{ ok: boolean; message: string }>;
  wifiForget(ssid: string): Promise<{ ok: boolean; message: string }>;
}

export const IPC = {
  getSettings: "settings:get",
  getSystemInfo: "system:info",
  recentLogs: "logs:recent",
  log: "logs:write",
  listProjects: "projects:list",
  getProject: "projects:get",
  createProjectFromPrompt: "projects:create",
  setTargetHeight: "models:setHeight",
  saveThumbnail: "models:saveThumbnail",
  generationProgress: "events:generation",
  submitRecording: "assistant:recording",
  sendText: "assistant:text",
  conversation: "assistant:conversation",
  printerStatus: "printer:status",
  printerInfo: "printer:info",
  printerStatusEvent: "events:printer",
  voiceTurn: "voice:turn",
  voiceText: "voice:text",
  voiceEvent: "events:voice",
  appEvent: "events:app",
  pendingAction: "actions:pending",
  confirmAction: "actions:confirm",
  cancelAction: "actions:cancel",
  requestRefine: "actions:refine",
  meshyBalance: "meshy:balance",
  testGemini: "gemini:test",
  preparePrint: "print:prepare",
  machineCommand: "printer:machine",
  machineCapabilities: "printer:capabilities",
  jobs: "jobs:list",
  portalInfo: "portal:info",
  latestPrintJob: "print:latest",
  requestPrint: "print:request",
  printStatus: "print:status",
  pausePrint: "print:pause",
  cancelPrint: "print:cancel",
  guardian: "guardian:get",
  guardianCommand: "guardian:command",
  guardianAnswer: "guardian:answer",
  guardianSimulate: "guardian:simulate",
  networkStatus: "network:status",
  wifiScan: "network:scan",
  wifiConnect: "network:connect",
  wifiForget: "network:forget",
} as const;

/** QD330 build volume as reported by the printer (M115: X 220, Y 220, Z 220). */
export const QD330_BUILD_VOLUME_MM = { x: 220, y: 220, z: 220 } as const;
