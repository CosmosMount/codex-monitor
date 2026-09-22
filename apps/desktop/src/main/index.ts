import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, safeStorage, session, shell, Tray } from "electron";
import { aggregateFleet, CODEX_DESKTOP_USER_AGENT, CodexCollector, discoverCodexModels, discoverLanHubs, HubSyncClient, SnapshotQueue, startLanHubAdvertiser, testCodexModel, UsageArchive, type DiscoveredHub, type HubSyncStatus, type LanHubAdvertiser, type ModelCheckResult, type ModelCheckerState } from "@codex-monitor/core";
import { createHub } from "@codex-monitor/hub";
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
let collector: CodexCollector | null = null;
let uploadQueue: SnapshotQueue | null = null;
let syncClient: HubSyncClient | null = null;
let hostedHub: Awaited<ReturnType<typeof createHub>> | null = null;
let lanAdvertiser: LanHubAdvertiser | null = null;
let discoveryTimer: NodeJS.Timeout | null = null;
let syncRestartGeneration = 0;
let launchAtLogin = false;
const startHidden = process.argv.includes("--hidden");

type SyncMode = "local" | "client" | "host";
interface SyncSettings { mode: SyncMode; hubUrl: string; autoDiscover: boolean; port: number; encryptedSecret: string | null }
interface SyncSettingsInput { mode: SyncMode; hubUrl?: string; autoDiscover?: boolean; port?: number; secret?: string }
const DEFAULT_SYNC_SETTINGS: SyncSettings = { mode: "local", hubUrl: "", autoDiscover: true, port: 17_321, encryptedSecret: null };
let syncSettings: SyncSettings = { ...DEFAULT_SYNC_SETTINGS };
let syncStatus: HubSyncStatus = { phase: "idle", hubUrl: "", queued: 0, lastReceivedAt: null, error: null };

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

async function publishSnapshot(snapshot: DeviceSnapshot): Promise<void> {
  if (!uploadQueue) return;
  uploadQueue.enqueue(snapshot);
  if (syncSettings.mode === "local") {
    uploadQueue.acknowledge(snapshot.sequence);
    return;
  }
  await syncClient?.push(snapshot).catch(() => undefined);
}

function publicSettings(): object {
  return {
    loginItem: launchAtLogin,
    version: app.getVersion(),
    sync: {
      mode: syncSettings.mode,
      hubUrl: syncSettings.hubUrl,
      autoDiscover: syncSettings.autoDiscover,
      port: syncSettings.port,
      secretConfigured: !!syncSettings.encryptedSecret || !!process.env.CODEX_MONITOR_SECRET,
      phase: syncStatus.phase,
      activeHubUrl: syncStatus.hubUrl,
      connected: syncStatus.phase === "connected",
      hostRunning: !!hostedHub,
      queued: uploadQueue?.size() ?? 0,
      lastReceivedAt: syncStatus.lastReceivedAt,
      error: syncStatus.error,
    },
  };
}

function emitSyncState(): void {
  mainWindow?.webContents.send("settings:sync-updated", publicSettings());
}

async function loadSyncSettings(): Promise<void> {
  try {
    const stored = JSON.parse(await readFile(join(app.getPath("userData"), "sync-settings.json"), "utf8")) as Partial<SyncSettings>;
    syncSettings = {
      mode: stored.mode === "client" || stored.mode === "host" ? stored.mode : "local",
      hubUrl: typeof stored.hubUrl === "string" ? normalizeHubUrl(stored.hubUrl) : "",
      autoDiscover: stored.autoDiscover !== false,
      port: validPort(stored.port),
      encryptedSecret: typeof stored.encryptedSecret === "string" ? stored.encryptedSecret : null,
    };
  } catch {
    const environmentUrl = process.env.CODEX_MONITOR_HUB_URL;
    const environmentSecret = process.env.CODEX_MONITOR_SECRET;
    syncSettings = { ...DEFAULT_SYNC_SETTINGS, mode: environmentUrl && environmentSecret ? "client" : "local", hubUrl: environmentUrl ? normalizeHubUrl(environmentUrl) : "" };
  }
}

async function saveSyncSettings(input: SyncSettingsInput): Promise<void> {
  const mode: SyncMode = input.mode === "client" || input.mode === "host" ? input.mode : "local";
  let encryptedSecret = syncSettings.encryptedSecret;
  if (input.secret) {
    if (input.secret.length < 16) throw new Error("Shared secret must contain at least 16 characters");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential encryption is unavailable; configure CODEX_MONITOR_SECRET instead");
    encryptedSecret = safeStorage.encryptString(input.secret).toString("base64");
  }
  if (mode !== "local" && !encryptedSecret && !process.env.CODEX_MONITOR_SECRET) throw new Error("A shared secret is required");
  syncSettings = {
    mode,
    hubUrl: mode === "client" ? normalizeHubUrl(input.hubUrl ?? "") : "",
    autoDiscover: input.autoDiscover !== false,
    port: validPort(input.port),
    encryptedSecret,
  };
  const path = join(app.getPath("userData"), "sync-settings.json");
  const temporary = `${path}.tmp`;
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(syncSettings, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await restartSync();
}

function readSyncSecret(): string | null {
  if (process.env.CODEX_MONITOR_SECRET) return process.env.CODEX_MONITOR_SECRET;
  if (!syncSettings.encryptedSecret || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(syncSettings.encryptedSecret, "base64")); } catch { return null; }
}

async function stopSyncResources(): Promise<void> {
  const previousClient = syncClient;
  const previousAdvertiser = lanAdvertiser;
  const previousHub = hostedHub;
  syncClient = null;
  lanAdvertiser = null;
  hostedHub = null;
  if (discoveryTimer) clearTimeout(discoveryTimer);
  discoveryTimer = null;
  previousClient?.stop();
  const closing: Promise<unknown>[] = [];
  if (previousAdvertiser) closing.push(previousAdvertiser.close());
  if (previousHub) closing.push(previousHub.app.close());
  await Promise.allSettled(closing);
}

async function restartSync(discoveredUrl?: string): Promise<void> {
  const generation = ++syncRestartGeneration;
  const settings = { ...syncSettings };
  const stopping = stopSyncResources();
  remoteFleet = null;
  syncStatus = { phase: "idle", hubUrl: "", queued: uploadQueue?.size() ?? 0, lastReceivedAt: null, error: null };
  emitSyncState();
  await stopping;
  if (generation !== syncRestartGeneration) return;
  if (settings.mode === "local" || shuttingDown) {
    if (settings.mode === "local") uploadQueue?.clear();
    return;
  }
  const secret = readSyncSecret();
  if (!secret) {
    syncStatus = { ...syncStatus, phase: "error", error: "Shared secret is unavailable from OS secure storage" };
    emitSyncState();
    return;
  }
  let hubUrl = discoveredUrl ?? settings.hubUrl;
  let pendingHub: Awaited<ReturnType<typeof createHub>> | null = null;
  let pendingAdvertiser: LanHubAdvertiser | null = null;
  try {
    if (settings.mode === "host") {
      pendingHub = await createHub({ databasePath: join(app.getPath("userData"), "hub.sqlite"), secret, logger: false });
      await pendingHub.app.listen({ host: "0.0.0.0", port: settings.port });
      if (generation !== syncRestartGeneration) {
        await pendingHub.app.close();
        return;
      }
      pendingAdvertiser = await startLanHubAdvertiser({ port: settings.port, name: `${app.getName()} on ${latestSnapshot?.device.name ?? process.platform}` });
      if (generation !== syncRestartGeneration) {
        await Promise.allSettled([pendingAdvertiser.close(), pendingHub.app.close()]);
        return;
      }
      hostedHub = pendingHub;
      lanAdvertiser = pendingAdvertiser;
      pendingHub = null;
      pendingAdvertiser = null;
      hubUrl = `http://127.0.0.1:${settings.port}`;
    } else if (!hubUrl && settings.autoDiscover) {
      syncStatus = { ...syncStatus, phase: "connecting", error: null };
      emitSyncState();
      hubUrl = (await discoverLanHubs(1_500))[0]?.url ?? "";
    }
    if (generation !== syncRestartGeneration) return;
    if (!hubUrl) {
      syncStatus = { ...syncStatus, phase: "reconnecting", error: "No Codex Monitor Hub found on the LAN" };
      emitSyncState();
      discoveryTimer = setTimeout(() => { if (generation === syncRestartGeneration) void restartSync(); }, 10_000);
      return;
    }
    if (!uploadQueue) return;
    const nextClient = new HubSyncClient({
      hubUrl,
      secret,
      queue: uploadQueue,
      onFleet: (value) => {
        if (generation !== syncRestartGeneration) return;
        remoteFleet = value;
        mainWindow?.webContents.send("monitor:updated", value);
      },
      onStatus: (value) => {
        if (generation !== syncRestartGeneration) return;
        syncStatus = value;
        emitSyncState();
      },
    });
    if (generation !== syncRestartGeneration) {
      nextClient.stop();
      return;
    }
    syncClient = nextClient;
    nextClient.start();
    if (latestSnapshot) await nextClient.push(latestSnapshot).catch(() => undefined);
  } catch (error) {
    await Promise.allSettled([
      ...(pendingAdvertiser ? [pendingAdvertiser.close()] : []),
      ...(pendingHub ? [pendingHub.app.close()] : []),
    ]);
    if (generation !== syncRestartGeneration) return;
    syncStatus = { ...syncStatus, phase: "error", hubUrl, error: error instanceof Error ? error.message : String(error) };
    emitSyncState();
    if (settings.mode === "client" && settings.autoDiscover) discoveryTimer = setTimeout(() => { if (generation === syncRestartGeneration) void restartSync(); }, 10_000);
  }
}

function normalizeHubUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Hub URL must use http:// or https://");
  if (parsed.username || parsed.password) throw new Error("Hub URL must not contain credentials");
  return parsed.toString().replace(/\/$/u, "");
}

function validPort(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535 ? value : 17_321;
}

async function readLaunchAtLogin(): Promise<boolean> {
  if (process.platform !== "linux") return app.getLoginItemSettings().openAtLogin;
  try { await readFile(join(homedir(), ".config", "autostart", "codex-monitor.desktop"), "utf8"); return true; } catch { return false; }
}

async function setLaunchAtLogin(enabled: boolean): Promise<boolean> {
  if (process.platform !== "linux") {
    app.setLoginItemSettings({ openAtLogin: enabled, args: enabled ? ["--hidden"] : [] });
    return app.getLoginItemSettings().openAtLogin;
  }
  const path = join(homedir(), ".config", "autostart", "codex-monitor.desktop");
  if (!enabled) {
    try { await unlink(path); } catch { /* Already disabled. */ }
    return false;
  }
  await mkdir(join(homedir(), ".config", "autostart"), { recursive: true });
  const executable = process.execPath.replace(/"/gu, "\\\"");
  await writeFile(path, `[Desktop Entry]\nType=Application\nName=Codex Monitor\nExec="${executable}" --hidden\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o600 });
  return true;
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
    if (startHidden) return;
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
    if (!collector) return fleet();
    const scanned = await collector.scan();
    latestSnapshot = archive?.merge(scanned) ?? scanned;
    await publishSnapshot(latestSnapshot);
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
  ipcMain.handle("settings:login-item", async (_event, enabled: boolean) => {
    launchAtLogin = await setLaunchAtLogin(enabled);
    return { openAtLogin: launchAtLogin };
  });
  ipcMain.handle("settings:state", () => publicSettings());
  ipcMain.handle("settings:sync-save", async (_event, input: SyncSettingsInput) => {
    await saveSyncSettings(input);
    return publicSettings();
  });
  ipcMain.handle("settings:sync-discover", async () => await discoverLanHubs(1_800));
  ipcMain.handle("settings:sync-connect", async (_event, hub: DiscoveredHub) => {
    if (!hub || typeof hub.url !== "string") throw new Error("Invalid discovered hub");
    await saveSyncSettings({ mode: "client", hubUrl: hub.url, autoDiscover: true, port: syncSettings.port });
    return publicSettings();
  });
  ipcMain.handle("devices:rename", async (_event, id: string, name: string) => {
    if (!syncClient) throw new Error("Hub is not connected");
    await syncClient.renameDevice(id, name.trim().slice(0, 80));
  });
  ipcMain.handle("devices:delete", async (_event, id: string) => {
    if (!syncClient) throw new Error("Hub is not connected");
    await syncClient.deleteDevice(id);
  });
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
  uploadQueue = new SnapshotQueue(join(app.getPath("userData"), "sync.sqlite"));
  await loadSyncSettings();
  launchAtLogin = await readLaunchAtLogin();
  collector = new CodexCollector({ sequence: uploadQueue.lastSequence() });
  await loadModelMonitors();
  registerIpc();
  createWindow();
  createTray();
  globalShortcut.register("CommandOrControl+Shift+U", () => mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show());
  collector.onSnapshot((snapshot) => {
    latestSnapshot = archive?.merge(snapshot) ?? snapshot;
    void publishSnapshot(latestSnapshot);
    mainWindow?.webContents.send("monitor:updated", fleet());
  });
  await collector.watch();
  latestSnapshot = archive.merge(await collector.scan());
  await publishSnapshot(latestSnapshot);
  mainWindow?.webContents.send("monitor:updated", fleet());
  await restartSync();
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
  if (discoveryTimer) clearTimeout(discoveryTimer);
  syncClient?.stop();
  void lanAdvertiser?.close();
  void hostedHub?.app.close();
  void collector?.close();
  archive?.close();
  uploadQueue?.close();
});
app.on("window-all-closed", () => {
  // Keep the collector and model heartbeats alive in the system tray.
});
