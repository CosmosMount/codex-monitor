import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { CodexCollector, UsageArchive, estimateApiCostUsd } from "../dist/index.js";
import { addUsage, emptyUsage } from "../../protocol/dist/index.js";

test("API-equivalent pricing partitions cached input and counts reasoning once", () => {
  const usage = { inputTokens: 100_000, cachedInputTokens: 40_000, cacheWriteTokens: 10_000, outputTokens: 9_000, reasoningTokens: 1_000, totalTokens: 110_000 };
  assert.equal(estimateApiCostUsd("gpt-6-sol", usage), .233);
  assert.equal(estimateApiCostUsd("gpt-6-sol", { ...usage, inputTokens: 300_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 90_000, reasoningTokens: 10_000 }), 2.7);
  assert.equal(estimateApiCostUsd("unknown-model", usage), null);
  assert.equal(estimateApiCostUsd("gpt-5.6", { ...usage, inputTokens: 10_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }), .04);
});

test("unknown prices remain visibly partial through aggregation", () => {
  const total = emptyUsage();
  addUsage(total, { totalTokens: 100, estimatedCostUsd: .1, unpricedTokens: 0 });
  addUsage(total, { totalTokens: 50, estimatedCostUsd: null });
  assert.equal(total.estimatedCostUsd, .1);
  assert.equal(total.unpricedTokens, 50);
});

test("concurrent collector refreshes share one scan and preserve sequence order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-monitor-scan-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const collector = new CodexCollector({ codexHome: root });
  const [first, concurrent] = await Promise.all([collector.scan(), collector.scan()]);
  assert.equal(first.sequence, concurrent.sequence);
  assert.equal((await collector.scan()).sequence, first.sequence + 1);
  await collector.close();
});

test("collector keeps cross-week session share and cost stable across rescan/archive", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-monitor-usage-"));
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const recent = new Date().toISOString();
  const record = (timestamp, turn, turnUsage, threadUsage) => JSON.stringify({
    timestamp,
    type: "token_usage_record",
    payload: { turn_id: turn, turn_token_usage: turnUsage, thread_token_usage: threadUsage },
  });
  const lines = [
    JSON.stringify({ timestamp: old, type: "session_meta", payload: { id: "cross-week", cwd: root, model: "gpt-6-sol" } }),
    record(old, "first", { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, reasoning_output_tokens: 10, total_tokens: 1100 }, { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, reasoning_output_tokens: 10, total_tokens: 1100 }),
    record(recent, "second", { input_tokens: 2000, cached_input_tokens: 1000, output_tokens: 200, reasoning_output_tokens: 20, total_tokens: 2200 }, { input_tokens: 3000, cached_input_tokens: 1200, output_tokens: 300, reasoning_output_tokens: 30, total_tokens: 3300 }),
  ];
  await writeFile(join(sessions, "cross-week.jsonl"), lines.join("\n") + "\n");
  const collector = new CodexCollector({ codexHome: root, deviceId: "test-device" });
  const first = await collector.scan();
  const second = await collector.scan();
  assert.equal(first.sessions[0].usage.totalTokens, 3300);
  assert.equal(first.sessions[0].weeklyUsage.totalTokens, 2200);
  assert.equal(first.periods.week.totalTokens, 2200);
  assert.equal(first.sessions[0].estimatedCostUsd, .00684);
  assert.equal(second.sessions[0].estimatedCostUsd, first.sessions[0].estimatedCostUsd);
  const archive = new UsageArchive(join(root, "archive.sqlite"));
  try {
    const merged = archive.merge(first);
    const replayed = archive.merge(second);
    assert.equal(merged.periods.all.totalTokens, replayed.periods.all.totalTokens);
    assert.equal(merged.periods.all.estimatedCostUsd, replayed.periods.all.estimatedCostUsd);
  } finally {
    archive.close();
    await collector.close();
  }
});
