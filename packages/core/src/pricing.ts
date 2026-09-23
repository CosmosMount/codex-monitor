import type { UsageVector } from "@codex-monitor/protocol";

/** Standard text API USD per million tokens, checked 2026-09-23.
 * Source: https://developers.openai.com/api/docs/pricing
 * This deliberately omits unknown models instead of inventing a price.
 */
const PRICES: Record<string, { input: number; cached: number; write: number; output: number; longContext?: boolean }> = {
  "gpt-6-astra": { input: 10, cached: 1, write: 12.5, output: 50, longContext: true },
  "gpt-6-sol": { input: 2, cached: .2, write: 2.5, output: 10, longContext: true },
  "gpt-6-luna": { input: .1, cached: .01, write: .125, output: .5, longContext: true },
  "gpt-5.6-sol": { input: 4, cached: .4, write: 5, output: 20, longContext: true },
  "gpt-5.6-terra": { input: 2, cached: .2, write: 2.5, output: 12, longContext: true },
  "gpt-5.6-luna": { input: .2, cached: .02, write: .25, output: 1.2, longContext: true },
  "gpt-5.5": { input: 5, cached: .5, write: 5, output: 30, longContext: true },
  "gpt-5.3-codex": { input: 1.75, cached: .175, write: 1.75, output: 14 },
  "gpt-5-codex": { input: 1.25, cached: .125, write: 1.25, output: 10 },
};

export function estimateApiCostUsd(model: string, usage: UsageVector): number | null {
  const price = PRICES[model === "gpt-5.6" ? "gpt-5.6-sol" : model];
  if (!price) return null;
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const written = Math.min(Math.max(0, usage.inputTokens - cached), usage.cacheWriteTokens);
  const fresh = Math.max(0, usage.inputTokens - cached - written);
  const long = price.longContext && usage.inputTokens > 272_000;
  const inputMultiplier = long ? 2 : 1;
  const outputMultiplier = long ? 1.5 : 1;
  // Codex log output and reasoning are normalized into disjoint buckets.
  return ((fresh * price.input + cached * price.cached + written * price.write) * inputMultiplier
    + (usage.outputTokens + usage.reasoningTokens) * price.output * outputMultiplier) / 1_000_000;
}
