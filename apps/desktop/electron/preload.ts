// The renderer's only bridge to the system: a fixed, typed set of calls.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type GenerationProgress, type MorphixApi, type PrinterStatus } from "@morphix/shared";

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: MorphixApi = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  getSystemInfo: () => ipcRenderer.invoke(IPC.getSystemInfo),
  recentLogs: (lines) => ipcRenderer.invoke(IPC.recentLogs, lines),
  log: (level, message) => ipcRenderer.send(IPC.log, level, message),

  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  getProject: (id) => ipcRenderer.invoke(IPC.getProject, id),
  createProjectFromPrompt: (prompt) => ipcRenderer.invoke(IPC.createProjectFromPrompt, prompt),
  setTargetHeight: (versionId, heightMm) => ipcRenderer.invoke(IPC.setTargetHeight, versionId, heightMm),
  saveThumbnail: (versionId, png) => ipcRenderer.invoke(IPC.saveThumbnail, versionId, png),
  onGenerationProgress: (cb) => subscribe<GenerationProgress>(IPC.generationProgress, cb),

  submitRecording: (pcm, rate) => ipcRenderer.invoke(IPC.submitRecording, pcm, rate),
  sendText: (text) => ipcRenderer.invoke(IPC.sendText, text),
  conversation: () => ipcRenderer.invoke(IPC.conversation),

  printerStatus: () => ipcRenderer.invoke(IPC.printerStatus),
  printerInfo: () => ipcRenderer.invoke(IPC.printerInfo),
  onPrinterStatus: (cb) => subscribe<PrinterStatus>(IPC.printerStatusEvent, cb),
};

contextBridge.exposeInMainWorld("morphix", api);
