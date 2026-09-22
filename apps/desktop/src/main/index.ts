import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, session, shell, Tray } from "electron";
import { aggregateFleet, CODEX_DESKTOP_USER_AGENT, CodexCollector, discoverCodexModels, testCodexModel, UsageArchive, type ModelCheckResult, type ModelCheckerState } from "@codex-monitor/core";
import type { DeviceSnapshot, FleetSnapshot } from "@codex-monitor/protocol";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let latestSnapshot: DeviceSnapshot | null = null;
let remoteFleet: FleetSnapshot | null = null;
let shuttingDown = false;
let archive: UsageArchive | null = null;
let modelState: ModelCheckerState | null = null;
let modelHistory: ModelCheckResult[] = [];
let monitorTimer: NodeJS.Timeout | null = null;
let modelMonitors: ModelMonitor[] = [];
const collector = new CodexCollector();
const hubUrl = process.env.CODEX_MONITOR_HUB_URL?.replace(/\/$/u, "");
const hubSecret = process.env.CODEX_MONITOR_SECRET;

interface ModelMonitor {
  id: string;
  model: string;
  intervalSeconds: number;
  enabled: boolean;
  nextRunAt: string;
  lastResult: ModelCheckResult | null;
}

function fleet(): FleetSnapshot {
  return remoteFleet ?? aggregateFleet(latestSnapshot ? [{ snapshot: latestSnapshot, receivedAt: latestSnapshot.observedAt, stale: false }] : [], latestSnapshot?.sequence ?? 0);
}

async function uploadToHub(snapshot: DeviceSnapshot): Promise<void> {
  if (!hubUrl || !hubSecret) return;
  try {
    await fetch(`${hubUrl}/api/v1/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${hubSecret}`, "content-type": "application/json" },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // The local view remains available. A later scan retries the latest snapshot.
  }
}

async function subscribeToHub(): Promise<void> {
  if (!hubUrl || !hubSecret) return;
  while (!shuttingDown) {
    try {
      const response = await fetch(`${hubUrl}/api/v1/stats/stream`, {
        headers: { authorization: `Bearer ${hubSecret}` },
        signal: AbortSignal.timeout(3_600_000),
      });
      if (!response.ok || !response.body) throw new Error(`Hub stream returned HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!shuttingDown) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split("\n\n");
        buffer = messages.pop() ?? "";
        for (const message of messages) {
          const data = message.split(/\r?\n/u).find((line) => line.startsWith("data: "))?.slice(6);
          if (!data) continue;
          remoteFleet = JSON.parse(data) as FleetSnapshot;
          mainWindow?.webContents.send("monitor:updated", remoteFleet);
        }
      }
    } catch {
      if (!shuttingDown) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#111216",
    title: "Codex Monitor",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  let shown = false;
  const showWindow = (): void => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    mainWindow.show();
  };
  mainWindow.once("ready-to-show", showWindow);
  mainWindow.webContents.once("did-finish-load", showWindow);
  setTimeout(showWindow, 2_000);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("close", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

function createTray(): void {
  const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="7" fill="#8492ff"/><path d="M20.8 10.2a8 8 0 1 0 0 11.6l-2.3-2.3a4.8 4.8 0 1 1 0-7z" fill="#fff"/><circle cx="22.5" cy="16" r="2.2" fill="#fff"/></svg>`;
  let icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(traySvg).toString("base64")}`);
  if (icon.isEmpty()) icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVR42mNgGAWjYBSMglEwCkbB////MzD8Z2BgYPjPwMDwH4qDBlD8j4GBgQEA3X8H+g/WiaAAAAAASUVORK5CYII=");
  tray = new Tray(icon.resize({ width: 16, height: 16, quality: "best" }));
  tray.setToolTip("Codex Monitor");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Codex Monitor", click: () => mainWindow?.show() },
    { type: "separator" },
    { label: "Quit", click: () => { shuttingDown = true; app.quit(); } },
  ]));
  tray.on("click", () => mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show());
  tray.on("double-click", () => mainWindow?.show());
}

async function loadModelState(): Promise<ModelCheckerState & { networkRoute: string }> {
  const catalog = await discoverCodexModels({ fetchImpl: net.fetch as typeof fetch });
  const networkRoute = await session.defaultSession.resolveProxy(catalog.endpoint).catch(() => "SYSTEM");
  return { ...catalog, networkRoute: sanitizeProxyRoute(networkRoute) };
}

function sanitizeProxyRoute(route: string): string {
  return route.replace(/(PROXY|HTTPS|SOCKS\d?)\s+([^;\s@]+):([^;\s@]+)@/giu, "$1 ••••@").slice(0, 240);
}

function registerIpc(): void {
  ipcMain.handle("monitor:snapshot", () => fleet());
  ipcMain.handle("monitor:refresh", async () => {
    const scanned = await collector.scan();
    latestSnapshot = archive?.merge(scanned) ?? scanned;
    return fleet();
  });
  ipcMain.handle("models:state", async () => {
    modelState ??= await loadModelState();
    return { catalog: modelState, history: modelHistory, monitors: modelMonitors };
  });
  ipcMain.handle("models:refresh", async () => {
    modelState = await loadModelState();
    return { catalog: modelState, history: modelHistory, monitors: modelMonitors };
  });
  ipcMain.handle("models:test", async (_event, model: string) => {
    const result = await runModelCheck(model);
    return result;
  });
  ipcMain.handle("models:test-all", async (_event, models: string[]) => {
    const results: ModelCheckResult[] = [];
    for (const model of models.slice(0, 32)) results.push(await runModelCheck(model));
    return results;
  });
  ipcMain.handle("models:monitor-upsert", async (_event, model: string, intervalSeconds: number) => {
    const interval = [60, 300, 900, 3600, 21600, 86400].includes(intervalSeconds) ? intervalSeconds : 21600;
    const existing = modelMonitors.find((item) => item.model === model);
    const monitor: ModelMonitor = existing ?? { id: `model-${Date.now()}`, model, intervalSeconds: interval, enabled: true, nextRunAt: new Date().toISOString(), lastResult: null };
    monitor.intervalSeconds = interval;
    monitor.enabled = true;
    monitor.nextRunAt = new Date(Date.now() + interval * 1_000).toISOString();
    if (!existing) modelMonitors.push(monitor);
    await saveModelMonitors();
    return modelMonitors;
  });
  ipcMain.handle("models:monitor-delete", async (_event, id: string) => {
    modelMonitors = modelMonitors.filter((item) => item.id !== id);
    await saveModelMonitors();
    return modelMonitors;
  });
  ipcMain.handle("models:monitor-run", async (_event, id: string) => {
    const monitor = modelMonitors.find((item) => item.id === id);
    if (!monitor) throw new Error("Model monitor not found");
    await executeMonitor(monitor);
    return modelMonitors;
  });
  ipcMain.handle("settings:login-item", (_event, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings();
  });
  ipcMain.handle("settings:state", () => ({ loginItem: app.getLoginItemSettings().openAtLogin, version: app.getVersion(), hubConfigured: !!hubUrl, hubConnected: !!remoteFleet }));
}

async function runModelCheck(model: string): Promise<ModelCheckResult> {
  const result = await testCodexModel(model, { fetchImpl: net.fetch as typeof fetch });
  modelHistory = [result, ...modelHistory].slice(0, 100);
  mainWindow?.webContents.send("models:updated", { catalog: modelState, history: modelHistory, monitors: modelMonitors });
  return result;
}

async function executeMonitor(monitor: ModelMonitor): Promise<void> {
  const previous = monitor.lastResult?.status;
  monitor.lastResult = await runModelCheck(monitor.model);
  monitor.nextRunAt = new Date(Date.now() + monitor.intervalSeconds * 1_000).toISOString();
  await saveModelMonitors();
  if (previous && previous !== monitor.lastResult.status) {
    const recovered = monitor.lastResult.status === "healthy";
    new Notification({
      title: recovered ? "Codex 模型已恢复" : "Codex 模型检查异常",
      body: recovered ? `${monitor.model} 已恢复正常响应` : `${monitor.model}: ${monitor.lastResult.error ?? `上游返回 ${monitor.lastResult.upstreamModel}`}`,
    }).show();
  }
}

async function loadModelMonitors(): Promise<void> {
  try {
    const value = JSON.parse(await readFile(join(app.getPath("userData"), "model-monitors.json"), "utf8"));
    modelMonitors = Array.isArray(value?.monitors) ? value.monitors.slice(0, 64) : [];
  } catch { modelMonitors = []; }
}

async function saveModelMonitors(): Promise<void> {
  const path = join(app.getPath("userData"), "model-monitors.json");
  const temporary = `${path}.tmp`;
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ monitors: modelMonitors }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function startModelMonitorLoop(): void {
  monitorTimer = setInterval(() => {
    const now = Date.now();
    for (const monitor of modelMonitors) {
      if (monitor.enabled && Date.parse(monitor.nextRunAt) <= now) void executeMonitor(monitor);
    }
  }, 30_000);
}

app.whenReady().then(async () => {
  await session.defaultSession.setProxy({ mode: "system" });
  // Chromium owns Sec-Fetch, Client Hints and compression headers. Setting the
  // identity at the session level avoids net.fetch rejecting forbidden headers.
  session.defaultSession.setUserAgent(CODEX_DESKTOP_USER_AGENT, "en-US,en");
  archive = new UsageArchive(join(app.getPath("userData"), "history.sqlite"));
  await loadModelMonitors();
  registerIpc();
  createWindow();
  createTray();
  globalShortcut.register("CommandOrControl+Shift+U", () => mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show());
  collector.onSnapshot((snapshot) => {
    latestSnapshot = archive?.merge(snapshot) ?? snapshot;
    void uploadToHub(latestSnapshot);
    mainWindow?.webContents.send("monitor:updated", fleet());
  });
  await collector.watch();
  latestSnapshot = archive.merge(await collector.scan());
  await uploadToHub(latestSnapshot);
  mainWindow?.webContents.send("monitor:updated", fleet());
  void subscribeToHub();
  startModelMonitorLoop();
});

app.on("activate", () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});
app.on("before-quit", () => { shuttingDown = true; });
app.on("will-quit", () => {
  shuttingDown = true;
  globalShortcut.unregisterAll();
  if (monitorTimer) clearInterval(monitorTimer);
  void collector.close();
  archive?.close();
});
app.on("window-all-closed", () => {
  // Keep the collector and model heartbeats alive in the system tray.
});
