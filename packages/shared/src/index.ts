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
  source: "demo" | "meshy";
  format: "stl" | "glb";
  /** URL the renderer can load (served by the local app server). */
  url: string;
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

export interface AppSettings {
  storageRoot: string;
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

/** Everything the renderer may call. Exposed by preload as window.morphix. */
export interface MorphixApi {
  getSettings(): Promise<AppSettings>;
  getSystemInfo(): Promise<SystemInfo>;
  recentLogs(lines?: number): Promise<string[]>;
  log(level: "info" | "warn" | "error", message: string): void;

  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<{ project: Project; versions: ModelVersion[] } | null>;
  createProjectFromPrompt(prompt: string): Promise<{ project: Project; taskId: string }>;
  setTargetHeight(versionId: string, heightMm: number): Promise<ModelVersion>;
  saveThumbnail(versionId: string, pngDataUrl: string): Promise<void>;
  onGenerationProgress(cb: (p: GenerationProgress) => void): () => void;

  submitRecording(pcm16: ArrayBuffer, sampleRate: number): Promise<RecordingResult>;
  sendText(text: string): Promise<RecordingResult>;
  conversation(): Promise<AssistantTurn[]>;

  printerStatus(): Promise<PrinterStatus>;
  printerInfo(): Promise<PrinterInfo>;
  onPrinterStatus(cb: (s: PrinterStatus) => void): () => void;
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
} as const;

/** QD330 build volume as reported by the printer (M115: X 220, Y 220, Z 220). */
export const QD330_BUILD_VOLUME_MM = { x: 220, y: 220, z: 220 } as const;
