import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "@iarna/toml";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
// Kept in lock-step with the Codex Desktop profile used by codex-model-tester.
const CODEX_CLIENT_VERSION = "26.901.51231";
export const CODEX_DESKTOP_USER_AGENT = `Codex Desktop/${CODEX_CLIENT_VERSION} (win32; x64)`;

export type ModelCatalogSource = "account" | "bootstrap" | "observed";

export interface ModelCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  contextWindow: number | null;
  maxContextWindow: number | null;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: string[];
  isDefault: boolean;
  source: ModelCatalogSource;
  accountAvailable: boolean;
}

export interface ModelCheckerState {
  status: "ready" | "unauthenticated" | "error";
  endpoint: string;
  endpointKind: "codex" | "openai-compatible";
  accountLabel: string | null;
  models: ModelCatalogEntry[];
  liveModelCount: number;
  catalogSource: "account+bootstrap" | "bootstrap-fallback";
  clientVersion: string;
  fetchedAt: string;
  error: string | null;
}

export interface ModelCheckResult {
  requestedModel: string;
  upstreamModel: string | null;
  match: boolean;
  status: "healthy" | "mismatch" | "error";
  responseStatus: string | null;
  responseId: string | null;
  latencyMs: number;
  timestamp: string;
  errorCode: string | null;
  error: string | null;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  } | null;
}

interface Credentials {
  accessToken: string;
  accountId: string | null;
  accountLabel: string | null;
  baseUrl: string;
  kind: ModelCheckerState["endpointKind"];
}

export interface ModelCheckerOptions {
  codexHome?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

const BASE_REASONING = ["low", "medium", "high", "xhigh"];
const BOOTSTRAP_MODELS: Array<[string, boolean, string, number, string[]]> = [
  ["gpt-6-astra", true, "low", 872_000, [...BASE_REASONING, "max", "ultra"]],
  ["gpt-5.6-sol", false, "low", 872_000, [...BASE_REASONING, "max", "ultra"]],
  ["gpt-5.6-terra", false, "medium", 872_000, [...BASE_REASONING, "max", "ultra"]],
  ["gpt-5.6-luna", false, "medium", 872_000, [...BASE_REASONING, "max"]],
  ["gpt-5.5", false, "medium", 272_000, BASE_REASONING],
  ["gpt-5.3-codex-spark", false, "high", 128_000, BASE_REASONING],
];

export async function discoverCodexModels(options: ModelCheckerOptions = {}): Promise<ModelCheckerState> {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const fetchedAt = new Date().toISOString();
  let credentials: Credentials;
  try {
    credentials = await loadCredentials(codexHome);
  } catch (error) {
    return stateWithBootstrap("unauthenticated", DEFAULT_CODEX_BASE_URL, "codex", null, fetchedAt, safeError(error));
  }

  const url = credentials.kind === "codex"
    ? `${credentials.baseUrl}/codex/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`
    : `${credentials.baseUrl}/models`;
  try {
    const response = await fetchWithDeadline(fetchImpl, url, {
      headers: requestHeaders(credentials, false),
    }, requestTimeoutMs);
    const body = await response.text();
    if (!response.ok) throw upstreamError(response.status, body);
    const decoded = JSON.parse(body) as Record<string, unknown>;
    const rawModels = credentials.kind === "codex"
      ? (Array.isArray(decoded.models) ? decoded.models : [])
      : (Array.isArray(decoded.data) ? decoded.data : Array.isArray(decoded.models) ? decoded.models : []);
    const liveModels = rawModels.map((item) => normalizeModel(item, "account", true)).filter((value): value is ModelCatalogEntry => value !== null);
    if (liveModels.length === 0) throw new Error(credentials.kind === "codex" ? "Codex 模型响应缺少有效的 models 数组" : "上游没有返回可用模型");
    return {
      status: "ready",
      endpoint: redactEndpoint(credentials.baseUrl),
      endpointKind: credentials.kind,
      accountLabel: credentials.accountLabel,
      models: mergeWithBootstrap(liveModels),
      liveModelCount: liveModels.length,
      catalogSource: "account+bootstrap",
      clientVersion: CODEX_CLIENT_VERSION,
      fetchedAt,
      error: null,
    };
  } catch (error) {
    return stateWithBootstrap("error", credentials.baseUrl, credentials.kind, credentials.accountLabel, fetchedAt, safeError(error));
  }
}

export async function testCodexModel(model: string, options: ModelCheckerOptions = {}): Promise<ModelCheckResult> {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  const requestedModel = model.trim();
  const started = performance.now();
  const timestamp = new Date().toISOString();
  if (!requestedModel) return failedResult(requestedModel, started, timestamp, "invalid_model", "模型名称不能为空");

  try {
    const credentials = await loadCredentials(codexHome);
    const url = credentials.kind === "codex" ? `${credentials.baseUrl}/codex/responses` : `${credentials.baseUrl}/responses`;
    const response = await fetchWithDeadline(fetchImpl, url, {
      method: "POST",
      headers: requestHeaders(credentials, true),
      body: JSON.stringify({
        model: requestedModel,
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: OK" }] }],
        reasoning: { effort: "low" },
        stream: true,
        store: false,
      }),
    }, requestTimeoutMs);
    if (!response.ok) throw upstreamError(response.status, await response.text());
    const completed = await withDeadline(readTerminalResponse(response), requestTimeoutMs, "等待 response.completed 超时");
    if (!completed) throw new Error("响应流在 response.completed 之前结束");
    const upstreamModel = textValue(completed.model);
    const responseStatus = textValue(completed.status) ?? "completed";
    const match = upstreamModel === requestedModel;
    return {
      requestedModel,
      upstreamModel,
      match,
      status: responseStatus === "completed" ? (match ? "healthy" : "mismatch") : "error",
      responseStatus,
      responseId: textValue(completed.id),
      latencyMs: Math.round(performance.now() - started),
      timestamp,
      errorCode: responseStatus === "completed" ? null : "upstream_status",
      error: responseStatus === "completed" ? null : `上游响应状态为 ${responseStatus}`,
      usage: normalizeUsage(completed.usage),
    };
  } catch (error) {
    const message = safeError(error);
    const match = message.match(/^\[([^\]]+)\]\s*/u);
    return failedResult(requestedModel, started, timestamp, match?.[1] ?? "request_failed", message.replace(/^\[[^\]]+\]\s*/u, ""));
  }
}

function bootstrapModels(): ModelCatalogEntry[] {
  return BOOTSTRAP_MODELS.map(([id, isDefault, defaultReasoningEffort, maxContextWindow, efforts]) => ({
    id,
    displayName: id,
    description: "Codex Desktop bootstrap catalog entry; a live check confirms account availability.",
    contextWindow: Math.min(272_000, maxContextWindow),
    maxContextWindow,
    defaultReasoningEffort,
    supportedReasoningEfforts: [...efforts],
    isDefault,
    source: "bootstrap",
    accountAvailable: false,
  }));
}

function mergeWithBootstrap(liveModels: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const merged = new Map(bootstrapModels().map((item) => [item.id, item]));
  for (const item of liveModels) merged.set(item.id, item);
  return [...merged.values()].sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || Number(right.accountAvailable) - Number(left.accountAvailable) || left.id.localeCompare(right.id));
}

function stateWithBootstrap(status: "unauthenticated" | "error", endpoint: string, endpointKind: ModelCheckerState["endpointKind"], accountLabel: string | null, fetchedAt: string, error: string): ModelCheckerState {
  return {
    status,
    endpoint: redactEndpoint(endpoint),
    endpointKind,
    accountLabel,
    models: bootstrapModels(),
    liveModelCount: 0,
    catalogSource: "bootstrap-fallback",
    clientVersion: CODEX_CLIENT_VERSION,
    fetchedAt,
    error,
  };
}

async function loadCredentials(codexHome: string): Promise<Credentials> {
  const auth = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8")) as Record<string, any>;
  const oauthToken = firstString(auth.tokens?.access_token, auth.access_token);
  const apiKey = firstString(auth.OPENAI_API_KEY, process.env.OPENAI_API_KEY);
  const accessToken = oauthToken ?? apiKey;
  if (!accessToken) throw new Error("未找到 Codex 登录凭据，请先在 Codex 中登录");
  const accountId = firstString(auth.tokens?.account_id, auth.account_id, jwtAccountId(accessToken));
  const email = firstString(auth.tokens?.email, auth.email, jwtEmail(accessToken));
  const kind: Credentials["kind"] = oauthToken ? "codex" : "openai-compatible";
  // A custom model provider in config.toml must not replace OAuth account discovery.
  const baseUrl = kind === "codex" ? DEFAULT_CODEX_BASE_URL : await configuredApiBaseUrl(codexHome);
  return {
    accessToken,
    accountId,
    accountLabel: email ? maskEmail(email) : accountId ? `账户 …${accountId.slice(-6)}` : "当前 Codex 账户",
    baseUrl: baseUrl.replace(/\/$/u, ""),
    kind,
  };
}

async function configuredApiBaseUrl(codexHome: string): Promise<string> {
  try {
    const config = parseToml(await readFile(join(codexHome, "config.toml"), "utf8")) as Record<string, any>;
    const direct = firstString(config.openai_base_url);
    if (direct) return direct.replace(/\/$/u, "");
    const providerName = firstString(config.model_provider);
    const provider = providerName ? config.model_providers?.[providerName] : null;
    return (firstString(provider?.base_url) ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/u, "");
  } catch {
    return DEFAULT_OPENAI_BASE_URL;
  }
}

function requestHeaders(credentials: Credentials, content: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${credentials.accessToken}`,
    accept: content ? "text/event-stream" : "application/json",
    originator: "Codex Desktop",
    "x-openai-internal-codex-residency": "us",
    "x-client-request-id": `req_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
  };
  if (content) {
    headers["content-type"] = "application/json";
    headers["openai-beta"] = "responses_websockets=2026-02-06";
  }
  if (credentials.accountId) headers["chatgpt-account-id"] = credentials.accountId;
  return headers;
}

async function fetchWithDeadline(fetchImpl: typeof fetch, input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  return withDeadline(fetchImpl(input, { ...init, signal: controller.signal }), timeoutMs, "连接上游超时", () => controller.abort());
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`[request_timeout] ${message}`));
        }, Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeModel(raw: unknown, source: ModelCatalogSource, accountAvailable: boolean): ModelCatalogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, any>;
  const id = firstString(value.slug, value.id, value.name);
  if (!id) return null;
  const efforts = Array.isArray(value.supported_reasoning_levels)
    ? value.supported_reasoning_levels
    : Array.isArray(value.supported_reasoning_efforts) ? value.supported_reasoning_efforts : [];
  return {
    id,
    displayName: firstString(value.display_name, value.name, id) ?? id,
    description: firstString(value.description) ?? "Codex 模型",
    contextWindow: finiteNumber(value.context_window),
    maxContextWindow: finiteNumber(value.max_context_window),
    defaultReasoningEffort: firstString(value.default_reasoning_level, value.default_reasoning_effort),
    supportedReasoningEfforts: efforts.map((item: any) => typeof item === "string" ? item.trim() : firstString(item?.effort, item?.reasoning_effort, item?.reasoningEffort)).filter((item: string | null): item is string => !!item),
    isDefault: value.is_default === true,
    source,
    accountAvailable,
  };
}

async function readTerminalResponse(response: Response): Promise<Record<string, any> | null> {
  if (!response.body) return terminalResponse(await response.text(), response.headers.get("content-type"));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
  const maxBytes = 8 * 1024 * 1024;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > maxBytes) throw new Error("模型检查响应超过 8 MiB 安全上限");
      if (/^(?:event|data):/iu.test(buffer.trimStart())) eventStream = true;
      if (!eventStream) continue;
      while (true) {
        const separator = /\r?\n\r?\n/u.exec(buffer);
        if (!separator || separator.index === undefined) break;
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const terminal = terminalFromEventBlock(block);
        if (terminal) {
          await reader.cancel().catch(() => undefined);
          return terminal;
        }
      }
    }
    buffer += decoder.decode();
    return terminalResponse(buffer, eventStream ? "text/event-stream" : response.headers.get("content-type"));
  } finally {
    reader.releaseLock();
  }
}

function terminalResponse(body: string, contentType: string | null): Record<string, any> | null {
  const trimmed = body.trimStart();
  const isEventStream = contentType?.toLowerCase().includes("text/event-stream") || /^(?:event|data):/iu.test(trimmed);
  if (!isEventStream) {
    const decoded = JSON.parse(body) as Record<string, any>;
    return decoded.response && typeof decoded.response === "object" ? decoded.response : decoded;
  }

  let terminal: Record<string, any> | null = null;
  for (const block of body.split(/\r?\n\r?\n/u)) {
    terminal = terminalFromEventBlock(block) ?? terminal;
  }
  return terminal;
}

function terminalFromEventBlock(block: string): Record<string, any> | null {
  let eventName = "";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (/^event:/iu.test(line)) eventName = line.slice(line.indexOf(":") + 1).trim();
    else if (/^data:/iu.test(line)) dataLines.push(line.slice(line.indexOf(":") + 1).trimStart());
  }
  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") return null;
  let event: Record<string, any>;
  try { event = JSON.parse(data) as Record<string, any>; } catch { return null; }
  const eventType = eventName || textValue(event.type) || "";
  if (eventType === "error") {
    const message = firstString(event.error?.message, event.message, event.error) ?? "上游返回未知流错误";
    throw new Error(`[upstream_stream_error] ${message}`);
  }
  if (eventType === "response.completed" || eventType === "response.incomplete") {
    return event.response && typeof event.response === "object" ? event.response : event;
  }
  return null;
}

function normalizeUsage(raw: unknown): ModelCheckResult["usage"] {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, any>;
  const inputTokens = finiteNumber(value.input_tokens) ?? 0;
  const outputTokens = finiteNumber(value.output_tokens) ?? 0;
  return {
    inputTokens,
    cachedInputTokens: finiteNumber(value.input_tokens_details?.cached_tokens, value.cached_tokens) ?? 0,
    outputTokens,
    reasoningTokens: finiteNumber(value.output_tokens_details?.reasoning_tokens, value.reasoning_tokens) ?? 0,
    totalTokens: finiteNumber(value.total_tokens) ?? inputTokens + outputTokens,
  };
}

function failedResult(model: string, started: number, timestamp: string, code: string, error: string): ModelCheckResult {
  return { requestedModel: model, upstreamModel: null, match: false, status: "error", responseStatus: null, responseId: null, latencyMs: Math.round(performance.now() - started), timestamp, errorCode: code, error, usage: null };
}

function upstreamError(status: number, body: string): Error {
  let message = body.slice(0, 240).replace(/\s+/gu, " ").trim();
  try {
    const decoded = JSON.parse(body) as Record<string, any>;
    message = firstString(decoded.error?.message, decoded.message, decoded.detail, message) ?? `HTTP ${status}`;
  } catch { /* use the bounded plain-text body */ }
  const code = status === 401 || status === 403 ? "authentication_failed" : status === 429 ? "rate_limited" : `http_${status}`;
  return new Error(`[${code}] ${message || `HTTP ${status}`}`);
}

function jwtPayload(token: string): Record<string, any> {
  try { return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")); } catch { return {}; }
}
function jwtAccountId(token: string): string | null {
  const payload = jwtPayload(token);
  return firstString(payload.chatgpt_account_id, payload["https://api.openai.com/auth"]?.chatgpt_account_id);
}
function jwtEmail(token: string): string | null { return firstString(jwtPayload(token).email); }
function maskEmail(email: string): string { const [name = "", domain] = email.split("@"); return domain ? `${name.slice(0, 2)}•••@${domain}` : "当前 Codex 账户"; }
function redactEndpoint(value: string): string { try { const url = new URL(value); url.username = ""; url.password = ""; return url.toString().replace(/\/$/u, ""); } catch { return "自定义端点"; } }
function firstString(...values: unknown[]): string | null { return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? null; }
function textValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function finiteNumber(...values: unknown[]): number | null { const value = values.find((item) => typeof item === "number" && Number.isFinite(item) && item >= 0); return typeof value === "number" ? value : null; }
function safeError(error: unknown): string { return error instanceof Error ? error.message.replace(/Bearer\s+\S+/giu, "Bearer ••••••••") : "未知错误"; }
export function modelFingerprint(model: string): string { return createHash("sha256").update(model).digest("hex").slice(0, 12); }
