import { homedir } from "node:os";
import { join } from "node:path";
import { CodexCollector, SnapshotQueue, UsageArchive } from "@codex-monitor/core";
import type { DeviceSnapshot } from "@codex-monitor/protocol";

const hubUrl = process.env.CODEX_MONITOR_HUB_URL?.replace(/\/$/u, "");
const secret = process.env.CODEX_MONITOR_SECRET;
if (!hubUrl || !secret) throw new Error("CODEX_MONITOR_HUB_URL and CODEX_MONITOR_SECRET are required");

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
});

let uploading = false;
async function enqueueAndFlush(snapshot: DeviceSnapshot): Promise<void> {
  snapshot = archive.merge(snapshot);
  queue.enqueue(snapshot);
  if (uploading) return;
  uploading = true;
  try {
    for (const pending of queue.list()) {
      const response = await fetch(`${hubUrl}/api/v1/ingest`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(pending),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Hub rejected snapshot: HTTP ${response.status}`);
      queue.acknowledge(pending.sequence);
    }
  } catch (error) {
    console.error(`[codex-monitor] upload deferred: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    uploading = false;
  }
}

collector.onSnapshot((snapshot) => void enqueueAndFlush(snapshot));
await collector.watch();
await enqueueAndFlush(await collector.scan());
const interval = setInterval(() => void collector.scan().then(enqueueAndFlush), Number(process.env.CODEX_MONITOR_SCAN_INTERVAL_MS ?? 60_000));

async function shutdown(): Promise<void> {
  clearInterval(interval);
  await collector.close();
  queue.close();
  archive.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
