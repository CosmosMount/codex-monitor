import type { CodexMonitorApi } from "../../preload/index";

declare global {
  interface Window {
    codexMonitor: CodexMonitorApi;
  }
}

export {};
