import { homedir } from "node:os";
import { join } from "node:path";
import { CodexCollector, discoverLanHubs, HubSyncClient, SnapshotQueue, UsageArchive } from "@codex-monitor/core";
import type { DeviceSnapshot } from "@codex-monitor/protocol";

const configuredHubUrl = process.env.CODEX_MONITOR_HUB_URL?.replace(/\/$/u, "");
const configuredSecret = process.env.CODEX_MONITOR_SECRET;
if (!configuredSecret) throw new Error("CODEX_MONITOR_SECRET is required; CODEX_MONITOR_HUB_URL can be omitted when LAN discovery is enabled");
const secret: string = configuredSecret;

const stateDir = process.env.CODEX_MONITOR_STATE_DIR ?? join(homedir(), ".codex-monitor");
const queue = new SnapshotQueue(join(stateDir, "agent.sqlite"));
const archive = new UsageArchive(join(stateDir, "history.sqlite"));
const deviceId = process.env.CODEX_MONITOR_DEVICE_ID;
const deviceName = process.env.CODEX_MONITOR_DEVICE_NAME;
const extraRoots = process.env.CODEX_MONITOR_EXTRA_ROOTS?.split(/[;,]/u).filter(Boolean);
const collector = new CodexCollector({
  ...(deviceId ? { deviceId } : {}),
  ...(deviceName ? { deviceName } : {}),
  ...(extraRoots?.length ? { extraRoots } : {}),
  sequence: queue.lastSequence(),
});

let syncClient: HubSyncClient | null = null;
let connecting = false;
let stopped = false;

async function connect(): Promise<void> {
  if (syncClient || connecting || stopped) return;
  connecting = true;
  try {
    const discovered = configuredHubUrl ? [] : await discoverLanHubs(1_500);
    const hubUrl = configuredHubUrl ?? discovered[0]?.url;
    if (!hubUrl) {
      console.info("[codex-monitor] no LAN hub discovered; snapshots remain in the local queue");
      return;
    }
    syncClient = new HubSyncClient({
      hubUrl,
      secret,
      queue,
      subscribe: false,
      onStatus: (status) => console.info(`[codex-monitor] hub ${status.phase}: ${status.hubUrl} (${status.queued} queued)${status.error ? ` · ${status.error}` : ""}`),
    });
    syncClient.start();
    console.info(`[codex-monitor] using hub ${hubUrl}${configuredHubUrl ? "" : " discovered on LAN"}`);
  } finally {
    connecting = false;
  }
}

async function enqueueAndFlush(snapshot: DeviceSnapshot): Promise<void> {
  snapshot = archive.merge(snapshot);
  queue.enqueue(snapshot);
  await connect();
  if (syncClient) await syncClient.push(snapshot).catch((error) => console.error(`[codex-monitor] upload deferred: ${error instanceof Error ? error.message : String(error)}`));
}

collector.onSnapshot((snapshot) => void enqueueAndFlush(snapshot));
await collector.watch();
await enqueueAndFlush(await collector.scan());
const interval = setInterval(() => void collector.scan().then(enqueueAndFlush), Number(process.env.CODEX_MONITOR_SCAN_INTERVAL_MS ?? 60_000));
const discoveryInterval = setInterval(() => void connect(), 15_000);

async function shutdown(): Promise<void> {
  stopped = true;
  clearInterval(interval);
  clearInterval(discoveryInterval);
  syncClient?.stop();
  await collector.close();
  queue.close();
  archive.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
