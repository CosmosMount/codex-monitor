import { contextBridge, ipcRenderer } from "electron";
import type { FleetSnapshot } from "@codex-monitor/protocol";

const api = {
  getSnapshot: (): Promise<FleetSnapshot> => ipcRenderer.invoke("monitor:snapshot"),
  refresh: (): Promise<FleetSnapshot> => ipcRenderer.invoke("monitor:refresh"),
  onSnapshot: (listener: (snapshot: FleetSnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: FleetSnapshot) => listener(snapshot);
    ipcRenderer.on("monitor:updated", handler);
    return () => ipcRenderer.removeListener("monitor:updated", handler);
  },
  getModelState: () => ipcRenderer.invoke("models:state"),
  refreshModels: () => ipcRenderer.invoke("models:refresh"),
  testModel: (model: string) => ipcRenderer.invoke("models:test", model),
  testAllModels: (models: string[]) => ipcRenderer.invoke("models:test-all", models),
  upsertModelMonitor: (model: string, intervalSeconds: number) => ipcRenderer.invoke("models:monitor-upsert", model, intervalSeconds),
  deleteModelMonitor: (id: string) => ipcRenderer.invoke("models:monitor-delete", id),
  runModelMonitor: (id: string) => ipcRenderer.invoke("models:monitor-run", id),
  onModelsUpdated: (listener: (state: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("models:updated", handler);
    return () => ipcRenderer.removeListener("models:updated", handler);
  },
  getSettings: () => ipcRenderer.invoke("settings:state"),
  setLoginItem: (enabled: boolean) => ipcRenderer.invoke("settings:login-item", enabled),
};

contextBridge.exposeInMainWorld("codexMonitor", api);
export type CodexMonitorApi = typeof api;
