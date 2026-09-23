export const SCHEMA_VERSION = 1 as const;

export type RangeKey = "today" | "week" | "month" | "7d" | "30d" | "all";

export interface UsageVector {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface UsageBreakdown extends UsageVector {
  sessions: number;
  turns: number;
  estimatedCostUsd: number | null;
  /** Tokens without a trustworthy API price (including older collector snapshots). */
  unpricedTokens?: number;
}

export interface DailyUsage {
  date: string;
  usage: UsageBreakdown;
}

export interface DimensionUsage {
  id: string;
  label: string;
  usage: UsageBreakdown;
}

export interface SessionSummary {
  id: string;
  model: string;
  projectId: string | null;
  projectLabel: string | null;
  startedAt: string;
  lastUsedAt: string;
  contextWindow: number | null;
  contextTokens: number | null;
  turns: number;
  usage: UsageVector;
  /** API-equivalent estimate, never the Codex subscription charge. */
  estimatedCostUsd?: number | null;
  unpricedTokens?: number;
  /** Calendar-week token activity, computed from cumulative counter deltas. */
  weeklyUsage?: UsageVector;
  weeklyStart?: string;
}

export interface CollectionHealth {
  status: "ok" | "partial" | "empty" | "error";
  observedAt: string;
  filesScanned: number;
  filesRejected: number;
  diagnostics: Array<{
    code: "source-missing" | "no-usage-observed" | "parse-failed" | "permission-denied";
    count?: number;
  }>;
}

export interface LimitWindow {
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export interface LimitStatus {
  source: "session-log";
  observedAt: string;
  limitId: string | null;
  limitName: string | null;
  primary: LimitWindow;
  secondary: LimitWindow | null;
}

export interface DeviceIdentity {
  id: string;
  name: string;
  platform: string;
  osVersion: string;
  agentVersion: string;
}

export interface DeviceSnapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  sequence: number;
  observedAt: string;
  accountFingerprint: string | null;
  device: DeviceIdentity;
  periods: Record<RangeKey, UsageBreakdown>;
  daily: DailyUsage[];
  models: DimensionUsage[];
  projects: DimensionUsage[];
  sessions: SessionSummary[];
  collection: CollectionHealth;
  limits: LimitStatus | null;
}

export interface DeviceStatus {
  snapshot: DeviceSnapshot;
  receivedAt: string;
  stale: boolean;
}

export interface FleetSnapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  revision: number;
  generatedAt: string;
  periods: Record<RangeKey, UsageBreakdown>;
  daily: DailyUsage[];
  models: DimensionUsage[];
  projects: DimensionUsage[];
  sessions: Array<SessionSummary & { deviceId: string; deviceName: string }>;
  devices: DeviceStatus[];
  limits: Array<{ deviceId: string; deviceName: string; status: LimitStatus }>;
}

export const EMPTY_USAGE: UsageBreakdown = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  sessions: 0,
  turns: 0,
  estimatedCostUsd: null,
  unpricedTokens: 0,
});

export function emptyUsage(): UsageBreakdown {
  return { ...EMPTY_USAGE };
}

export function addUsage(target: UsageBreakdown, value: Partial<UsageBreakdown>): UsageBreakdown {
  target.inputTokens += finite(value.inputTokens);
  target.cachedInputTokens += finite(value.cachedInputTokens);
  target.cacheWriteTokens += finite(value.cacheWriteTokens);
  target.outputTokens += finite(value.outputTokens);
  target.reasoningTokens += finite(value.reasoningTokens);
  target.totalTokens += finite(value.totalTokens);
  target.sessions += finite(value.sessions);
  target.turns += finite(value.turns);
  if (value.estimatedCostUsd != null && Number.isFinite(value.estimatedCostUsd)) {
    target.estimatedCostUsd = (target.estimatedCostUsd ?? 0) + value.estimatedCostUsd;
  }
  target.unpricedTokens = (target.unpricedTokens ?? 0) + (value.unpricedTokens === undefined
    ? value.estimatedCostUsd == null ? finite(value.totalTokens) : 0
    : finite(value.unpricedTokens));
  return target;
}

function finite(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function isDeviceSnapshot(value: unknown): value is DeviceSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DeviceSnapshot>;
  return candidate.schemaVersion === SCHEMA_VERSION
    && Number.isSafeInteger(candidate.sequence)
    && candidate.sequence! >= 0
    && typeof candidate.observedAt === "string"
    && !!candidate.device
    && typeof candidate.device.id === "string"
    && candidate.device.id.length > 0
    && candidate.device.id.length <= 128
    && !!candidate.periods
    && Array.isArray(candidate.sessions)
    && Array.isArray(candidate.daily);
}
