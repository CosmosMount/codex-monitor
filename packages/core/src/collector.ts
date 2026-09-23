import { createHash } from "node:crypto";
import { hostname, platform, release } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import {
  SCHEMA_VERSION,
  addUsage,
  emptyUsage,
  type DailyUsage,
  type DeviceSnapshot,
  type DimensionUsage,
  type RangeKey,
  type UsageBreakdown,
  type UsageVector,
} from "@codex-monitor/protocol";
import { parseCodexSession, type ParsedSession } from "./codex-parser.js";
import { estimateApiCostUsd } from "./pricing.js";

export interface CollectorOptions {
  codexHome?: string;
  extraRoots?: string[];
  deviceId?: string;
  deviceName?: string;
  sequence?: number;
  maxSessions?: number;
}

export class CodexCollector {
  readonly roots: string[];
  private readonly codexHome: string;
  private readonly discoveredRoots: Promise<string[]>;
  private watcher: FSWatcher | null = null;
  private sequence: number;
  private listeners = new Set<(snapshot: DeviceSnapshot) => void>();
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: CollectorOptions = {}) {
    const root = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.codexHome = root;
    this.roots = [join(root, "sessions"), join(root, "archived_sessions"), ...(options.extraRoots ?? [])];
    this.discoveredRoots = platform() === "win32" ? discoverWslCodexRoots() : Promise.resolve([]);
    this.sequence = options.sequence ?? 0;
  }

  async scan(): Promise<DeviceSnapshot> {
    const roots = [...this.roots, ...await this.discoveredRoots];
    const files: string[] = [];
    for (const root of roots) files.push(...await findJsonl(root));
    const sessions = new Map<string, ParsedSession>();
    let rejected = 0;
    for (const file of files) {
      try {
        const parsed = await parseCodexSession(file);
        if (!parsed) continue;
        const previous = sessions.get(parsed.summary.id);
        if (!previous
          || parsed.summary.lastUsedAt > previous.summary.lastUsedAt
          || (parsed.summary.lastUsedAt === previous.summary.lastUsedAt && parsed.summary.usage.totalTokens > previous.summary.usage.totalTokens)) {
          sessions.set(parsed.summary.id, parsed);
        }
      } catch {
        rejected += 1;
      }
    }

    const observedAt = new Date().toISOString();
    const parsedSessions = [...sessions.values()].sort((a, b) => b.summary.lastUsedAt.localeCompare(a.summary.lastUsedAt));
    return buildSnapshot(parsedSessions, {
      observedAt,
      sequence: ++this.sequence,
      ...(this.options.deviceId ? { deviceId: this.options.deviceId } : {}),
      ...(this.options.deviceName ? { deviceName: this.options.deviceName } : {}),
      filesScanned: files.length,
      filesRejected: rejected,
      rootsFound: await anyRootExists(roots),
      maxSessions: this.options.maxSessions ?? 5_000,
      accountFingerprint: await accountFingerprint(this.codexHome),
    });
  }

  async watch(): Promise<void> {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.roots, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
      usePolling: process.env.CODEX_MONITOR_WATCH_POLLING === "1",
    });
    this.watcher.on("add", () => this.scheduleRefresh());
    this.watcher.on("change", () => this.scheduleRefresh());
    this.watcher.on("unlink", () => this.scheduleRefresh());
  }

  onSnapshot(listener: (snapshot: DeviceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await this.watcher?.close();
    this.watcher = null;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      try {
        const snapshot = await this.scan();
        for (const listener of this.listeners) listener(snapshot);
      } catch {
        // A later filesystem event or scheduled scan will retry.
      }
    }, 650);
  }
}

interface SnapshotBuildOptions {
  observedAt: string;
  sequence: number;
  deviceId?: string;
  deviceName?: string;
  filesScanned: number;
  filesRejected: number;
  rootsFound: boolean;
  maxSessions: number;
  accountFingerprint: string | null;
}

function buildSnapshot(sessions: ParsedSession[], options: SnapshotBuildOptions): DeviceSnapshot {
  const now = new Date(options.observedAt);
  const weeklyStart = dateKey(startForRange("week", now));
  const dailyMap = new Map<string, UsageBreakdown>();
  const modelMap = new Map<string, UsageBreakdown>();
  const projectMap = new Map<string, { label: string; usage: UsageBreakdown }>();

  for (const session of sessions) {
    const sessionCost = emptyUsage();
    const sessionModels = new Set<string>();
    const weeklyUsage: UsageVector = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
    for (const event of session.activity) {
      sessionModels.add(event.model);
      const priced = pricedVector(event.usage, event.model);
      addUsage(sessionCost, { ...event.usage, ...priced });
      addDimension(modelMap, event.model, event.usage, 0, priced);
      if (event.timestamp.slice(0, 10) >= weeklyStart) addVector(weeklyUsage, event.usage);
    }
    const missingTokens = Math.max(0, session.summary.usage.totalTokens - sessionCost.totalTokens);
    sessionCost.unpricedTokens = (sessionCost.unpricedTokens ?? 0) + missingTokens;
    if (missingTokens > 0) {
      sessionModels.add(session.summary.model);
      const unknownModel = modelMap.get(session.summary.model) ?? emptyUsage();
      unknownModel.totalTokens += missingTokens;
      unknownModel.unpricedTokens = (unknownModel.unpricedTokens ?? 0) + missingTokens;
      modelMap.set(session.summary.model, unknownModel);
    }
    const pricedSession = { ...session.summary, estimatedCostUsd: sessionCost.estimatedCostUsd, unpricedTokens: sessionCost.unpricedTokens, ...(missingTokens > 0 ? {} : { weeklyUsage }), weeklyStart };
    session.summary = pricedSession;
    if (sessionModels.size === 0) sessionModels.add(session.summary.model);
    for (const model of sessionModels) {
      const modelBucket = modelMap.get(model) ?? emptyUsage();
      modelBucket.sessions += 1;
      modelMap.set(model, modelBucket);
    }
    for (const turn of session.turns) {
      const modelBucket = modelMap.get(turn.model) ?? emptyUsage();
      modelBucket.turns += 1;
      modelMap.set(turn.model, modelBucket);
    }
    if (session.summary.projectId) {
      const current = projectMap.get(session.summary.projectId) ?? {
        label: session.summary.projectLabel ?? "Unknown project",
        usage: emptyUsage(),
      };
      addVectorToBreakdown(current.usage, session.summary.usage, session.summary.turns, 1, sessionCost);
      projectMap.set(session.summary.projectId, current);
    }
    for (const event of session.activity) {
      const day = event.timestamp.slice(0, 10);
      const bucket = dailyMap.get(day) ?? emptyUsage();
      addVectorToBreakdown(bucket, event.usage, 0, 0, pricedVector(event.usage, event.model));
      dailyMap.set(day, bucket);
    }
    for (const turn of session.turns) {
      const day = turn.timestamp.slice(0, 10);
      const bucket = dailyMap.get(day) ?? emptyUsage();
      bucket.turns += 1;
      dailyMap.set(day, bucket);
    }
  }

  const daily: DailyUsage[] = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, usage]) => ({ date, usage }));
  const all = sessions.reduce((sum, session) => addVectorToBreakdown(sum, session.summary.usage, session.summary.turns, 1, {
    estimatedCostUsd: session.summary.estimatedCostUsd ?? null,
    unpricedTokens: session.summary.unpricedTokens ?? session.summary.usage.totalTokens,
  }), emptyUsage());
  const periods = Object.fromEntries((["today", "week", "month", "7d", "30d"] as RangeKey[]).map((key) => [key, periodUsage(daily, key, now)])) as Record<RangeKey, UsageBreakdown>;
  for (const key of ["today", "week", "month", "7d", "30d"] as RangeKey[]) {
    const start = startForRange(key, now);
    periods[key].sessions = sessions.filter((session) => new Date(session.summary.lastUsedAt) >= start).length;
  }
  periods.all = all;

  return {
    schemaVersion: SCHEMA_VERSION,
    sequence: options.sequence,
    observedAt: options.observedAt,
    accountFingerprint: options.accountFingerprint,
    device: {
      id: options.deviceId ?? createHash("sha256").update(`${hostname()}|${platform()}`).digest("hex").slice(0, 20),
      name: options.deviceName ?? hostname(),
      platform: `${platform()}-${process.arch}`,
      osVersion: release(),
      agentVersion: "0.3.0",
    },
    periods,
    daily,
    models: dimensionList(modelMap),
    projects: [...projectMap.entries()].map(([id, value]) => ({ id, label: value.label, usage: value.usage })).sort(byTokens),
    sessions: sessions.slice(0, options.maxSessions).map((session) => session.summary),
    collection: {
      status: options.filesRejected > 0 ? "partial" : sessions.length > 0 ? "ok" : options.rootsFound ? "empty" : "error",
      observedAt: options.observedAt,
      filesScanned: options.filesScanned,
      filesRejected: options.filesRejected,
      diagnostics: [
        ...(!options.rootsFound ? [{ code: "source-missing" as const }] : []),
        ...(options.rootsFound && sessions.length === 0 ? [{ code: "no-usage-observed" as const }] : []),
        ...(options.filesRejected > 0 ? [{ code: "parse-failed" as const, count: options.filesRejected }] : []),
      ],
    },
    limits: sessions.map((session) => session.limits).filter((value) => value != null).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0] ?? null,
  };
}

function periodUsage(daily: DailyUsage[], range: RangeKey, now: Date): UsageBreakdown {
  const start = startForRange(range, now);
  return daily.filter((entry) => new Date(`${entry.date}T00:00:00`) >= start).reduce((sum, entry) => addUsage(sum, entry.usage), emptyUsage());
}

function startForRange(range: RangeKey, now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (range === "month") start.setDate(1);
  if (range === "7d") start.setDate(start.getDate() - 6);
  if (range === "30d") start.setDate(start.getDate() - 29);
  return start;
}

function addVectorToBreakdown(target: UsageBreakdown, usage: UsageVector, turns: number, sessions: number, cost: Pick<UsageBreakdown, "estimatedCostUsd" | "unpricedTokens">): UsageBreakdown {
  return addUsage(target, { ...usage, turns, sessions, ...cost });
}

function addDimension(map: Map<string, UsageBreakdown>, key: string, usage: UsageVector, turns: number, cost: Pick<UsageBreakdown, "estimatedCostUsd" | "unpricedTokens">): void {
  const current = map.get(key) ?? emptyUsage();
  addVectorToBreakdown(current, usage, turns, 0, cost);
  map.set(key, current);
}

function pricedVector(usage: UsageVector, model: string): Pick<UsageBreakdown, "estimatedCostUsd" | "unpricedTokens"> {
  const estimatedCostUsd = estimateApiCostUsd(model, usage);
  return { estimatedCostUsd, unpricedTokens: estimatedCostUsd === null ? usage.totalTokens : 0 };
}

function addVector(target: UsageVector, value: UsageVector): void {
  target.inputTokens += value.inputTokens;
  target.cachedInputTokens += value.cachedInputTokens;
  target.cacheWriteTokens += value.cacheWriteTokens;
  target.outputTokens += value.outputTokens;
  target.reasoningTokens += value.reasoningTokens;
  target.totalTokens += value.totalTokens;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dimensionList(map: Map<string, UsageBreakdown>): DimensionUsage[] {
  return [...map.entries()].map(([id, usage]) => ({ id, label: id, usage })).sort(byTokens);
}

function byTokens(a: DimensionUsage, b: DimensionUsage): number {
  return b.usage.totalTokens - a.usage.totalTokens;
}

async function findJsonl(root: string): Promise<string[]> {
  const output: string[] = [];
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) output.push(...await findJsonl(path));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(path);
    }
  } catch {
    return output;
  }
  return output;
}

async function anyRootExists(roots: string[]): Promise<boolean> {
  for (const root of roots) {
    try {
      if ((await stat(root)).isDirectory()) return true;
    } catch {
      // Continue checking configured alternatives.
    }
  }
  return false;
}

async function accountFingerprint(codexHome: string): Promise<string | null> {
  try {
    const auth = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
    const stableId = [auth.account_id, auth.email, auth.tokens?.account_id, auth.tokens?.email].find((value) => typeof value === "string" && value.length > 0);
    return stableId ? createHash("sha256").update(`codex-monitor:${stableId}`).digest("hex") : null;
  } catch {
    return null;
  }
}

async function discoverWslCodexRoots(): Promise<string[]> {
  const run = promisify(execFile);
  try {
    const { stdout } = await run("wsl.exe", ["--list", "--quiet"], { windowsHide: true, timeout: 4_000 });
    const distros = stdout.replace(/\0/gu, "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean).slice(0, 16);
    const paths = await Promise.all(distros.map(async (distro) => {
      try {
        const result = await run("wsl.exe", ["-d", distro, "--", "sh", "-lc", "wslpath -w \"${CODEX_HOME:-$HOME/.codex}\""], { windowsHide: true, timeout: 4_000 });
        const root = result.stdout.trim();
        return root ? [join(root, "sessions"), join(root, "archived_sessions")] : [];
      } catch { return []; }
    }));
    return paths.flat();
  } catch {
    return [];
  }
}
