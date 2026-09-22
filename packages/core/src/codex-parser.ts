import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { LimitStatus, LimitWindow, SessionSummary, UsageVector } from "@codex-monitor/protocol";

interface ParsedTurn {
  id: string;
  timestamp: string;
  model: string;
  usage: UsageVector;
}

interface ParsedUsageEvent {
  timestamp: string;
  model: string;
  usage: UsageVector;
}

export interface ParsedSession {
  summary: SessionSummary;
  turns: ParsedTurn[];
  activity: ParsedUsageEvent[];
  limits: LimitStatus | null;
}

const EMPTY_VECTOR: UsageVector = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

export async function parseCodexSession(filePath: string): Promise<ParsedSession | null> {
  const content = await readFile(filePath, "utf8");
  let id = basename(filePath, ".jsonl");
  let cwd: string | null = null;
  let model = "unknown";
  let startedAt: string | null = null;
  let lastUsedAt: string | null = null;
  let contextWindow: number | null = null;
  let contextTokens: number | null = null;
  const recordTurns = new Map<string, ParsedTurn>();
  const legacyTurns: ParsedTurn[] = [];
  const recordCumulative: ParsedUsageEvent[] = [];
  const legacyCumulative: ParsedUsageEvent[] = [];
  let limits: LimitStatus | null = null;

  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = validTimestamp(record.timestamp) ?? new Date(0).toISOString();
    startedAt = earlierTimestamp(startedAt, timestamp);
    lastUsedAt = laterTimestamp(lastUsedAt, timestamp);
    const payload = record.payload ?? {};

    if (record.type === "session_meta") {
      // Codex task identity is payload.id. session_id can identify a shared
      // runtime and would incorrectly collapse otherwise unrelated tasks.
      id = stringValue(payload.id) ?? stringValue(payload.session_id) ?? id;
      cwd = stringValue(payload.cwd) ?? cwd;
      contextWindow = positiveNumber(payload.context_window) ?? contextWindow;
      model = stringValue(payload.model) ?? model;
      continue;
    }

    if (record.type === "turn_context") {
      model = stringValue(payload.model) ?? model;
      cwd = stringValue(payload.cwd) ?? cwd;
      contextWindow = positiveNumber(payload.model_context_window) ?? contextWindow;
      continue;
    }

    if (record.type === "event_msg" && payload.type === "token_count" && payload.info && typeof payload.info === "object") {
      const lastUsage = payload.info.last_token_usage ?? payload.info.lastTokenUsage;
      const totalUsage = usageVector(payload.info.total_token_usage ?? payload.info.totalTokenUsage);
      contextWindow = positiveNumber(payload.info.model_context_window ?? payload.info.modelContextWindow) ?? contextWindow;
      contextTokens = positiveNumber(lastUsage?.total_tokens ?? lastUsage?.totalTokens) ?? contextTokens;
      if (totalUsage.totalTokens > 0) {
        legacyCumulative.push({ timestamp, model, usage: totalUsage });
        const turnUsage = usageVector(lastUsage);
        if (turnUsage.totalTokens > 0) {
          legacyTurns.push({ id: `event-${legacyTurns.length}`, timestamp, model, usage: turnUsage });
        }
      }
    }

    if (record.type === "event_msg" && payload.rate_limits) {
      const primary = limitWindow(payload.rate_limits.primary);
      if (primary) {
        limits = {
          source: "session-log",
          observedAt: timestamp,
          limitId: stringValue(payload.rate_limits.limit_id),
          limitName: stringValue(payload.rate_limits.limit_name),
          primary,
          secondary: limitWindow(payload.rate_limits.secondary),
        };
      }
      continue;
    }

    if (record.type !== "token_usage_record") continue;
    const turnId = stringValue(payload.turn_id) ?? `record-${recordTurns.size}`;
    const turnUsage = usageVector(payload.turn_token_usage ?? payload.usage);
    const threadUsage = usageVector(payload.thread_token_usage);
    if (threadUsage.totalTokens > 0) recordCumulative.push({ timestamp, model, usage: threadUsage });
    contextTokens = positiveNumber(payload.usage?.total_tokens) ?? contextTokens;
    recordTurns.set(turnId, { id: turnId, timestamp, model, usage: turnUsage });
  }

  // event_msg/token_count is the stable counter schema used by both old and
  // current Codex rollouts. token_usage_record remains a compatibility fallback.
  const authoritativeCumulative = legacyCumulative.length > 0 ? legacyCumulative : recordCumulative;
  const turnList = (recordTurns.size > 0 ? [...recordTurns.values()] : legacyTurns)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (authoritativeCumulative.length === 0 && turnList.length === 0) return null;
  const summedTurns = turnList.reduce((sum, turn) => addVector(sum, turn.usage), { ...EMPTY_VECTOR });
  const sessionUsage = authoritativeCumulative.at(-1)?.usage ?? summedTurns;
  const detailedCumulative = recordCumulative.at(-1)?.usage.totalTokens === sessionUsage.totalTokens
    ? recordCumulative
    : authoritativeCumulative;
  const activity = detailedCumulative.length > 0
    ? cumulativeActivity(detailedCumulative)
    : turnList.map(({ timestamp, model: turnModel, usage }) => ({ timestamp, model: turnModel, usage }));

  const safeStart = startedAt ?? lastUsedAt ?? new Date(0).toISOString();
  const safeLast = lastUsedAt ?? safeStart;
  const projectId = cwd ? createHash("sha256").update(cwd).digest("hex").slice(0, 24) : null;
  const projectLabel = cwd ? basename(cwd) : null;

  return {
    summary: {
      id,
      model,
      projectId,
      projectLabel,
      startedAt: safeStart,
      lastUsedAt: safeLast,
      contextWindow,
      contextTokens,
      turns: turnList.length,
      usage: sessionUsage,
    },
    turns: turnList,
    activity,
    limits,
  };
}

function cumulativeActivity(records: ParsedUsageEvent[]): ParsedUsageEvent[] {
  // If a task counter was reset, only the final monotonic segment can reconcile
  // with the authoritative latest cumulative snapshot.
  let start = 0;
  for (let index = 1; index < records.length; index += 1) {
    if (records[index]!.usage.totalTokens < records[index - 1]!.usage.totalTokens) start = index;
  }
  const activity: ParsedUsageEvent[] = [];
  let previous = { ...EMPTY_VECTOR };
  for (const record of records.slice(start)) {
    const delta = subtractVector(record.usage, previous);
    if (delta.totalTokens > 0) activity.push({ timestamp: record.timestamp, model: record.model, usage: delta });
    previous = record.usage;
  }
  return activity;
}

function limitWindow(raw: any): LimitWindow | null {
  if (!raw || typeof raw !== "object" || typeof raw.used_percent !== "number") return null;
  const usedPercent = Math.min(100, Math.max(0, raw.used_percent));
  const resetsAt = typeof raw.resets_at === "number"
    ? new Date(raw.resets_at * 1_000).toISOString()
    : validTimestamp(raw.resets_at);
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowMinutes: positiveNumber(raw.window_minutes),
    resetsAt,
  };
}

function usageVector(raw: any): UsageVector {
  if (!raw || typeof raw !== "object") return { ...EMPTY_VECTOR };
  const inputTokens = token(raw.input_tokens);
  const rawOutputTokens = token(raw.output_tokens);
  const reasoningTokens = token(raw.reasoning_output_tokens);
  const totalTokens = token(raw.total_tokens);
  // Current Codex rollouts include reasoning in output_tokens. Normalize to the
  // disjoint buckets used by Token Monitor/tokscale so the displayed components
  // close over totalTokens without counting reasoning twice. Older disjoint
  // records remain untouched.
  const outputIncludesReasoning = totalTokens > 0 && inputTokens + rawOutputTokens === totalTokens;
  return {
    inputTokens,
    cachedInputTokens: token(raw.cached_input_tokens),
    cacheWriteTokens: token(raw.cache_write_input_tokens),
    outputTokens: outputIncludesReasoning ? Math.max(0, rawOutputTokens - reasoningTokens) : rawOutputTokens,
    reasoningTokens,
    totalTokens,
  };
}

function token(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function earlierTimestamp(current: string | null, next: string): string {
  return current === null || next < current ? next : current;
}

function laterTimestamp(current: string | null, next: string): string {
  return current === null || next > current ? next : current;
}

function addVector(a: UsageVector, b: UsageVector): UsageVector {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function subtractVector(a: UsageVector, b: UsageVector): UsageVector {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
    cacheWriteTokens: Math.max(0, a.cacheWriteTokens - b.cacheWriteTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    reasoningTokens: Math.max(0, a.reasoningTokens - b.reasoningTokens),
    totalTokens: Math.max(0, a.totalTokens - b.totalTokens),
  };
}
