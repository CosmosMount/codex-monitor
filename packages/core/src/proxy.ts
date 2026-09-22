import { promises as dns } from "node:dns";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { ProxyAgent } from "proxy-agent";

const execFileAsync = promisify(execFile);

export type ProxySource = "environment" | "codex" | "system";
export type ProxyProtocol = "http" | "https" | "socks4" | "socks5" | "direct" | "unknown";

export interface ProxyCandidate {
  id: string;
  source: ProxySource;
  label: string;
  url: string;
  protocol: ProxyProtocol;
  active: boolean;
  mutable: boolean;
  bypass: string[];
}

export interface DiagnosticStage {
  stage: "parse" | "dns" | "tcp" | "tls" | "http";
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  detail: string;
}

export interface ProxyDiagnostic {
  candidateId: string;
  startedAt: string;
  completedAt: string;
  ok: boolean;
  stages: DiagnosticStage[];
}

export async function discoverProxies(codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")): Promise<ProxyCandidate[]> {
  const candidates: ProxyCandidate[] = [];
  const bypass = splitBypass(process.env.NO_PROXY ?? process.env.no_proxy ?? "");
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"] as const) {
    const value = process.env[key] ?? process.env[key.toLowerCase()];
    if (value) candidates.push(candidate(`env-${key.toLowerCase()}`, "environment", key, value, true, bypass));
  }

  try {
    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    const baseUrl = findTomlString(config, "openai_base_url");
    if (baseUrl) candidates.push(candidate("codex-openai-base", "codex", "Codex OpenAI base URL", baseUrl, true));
    for (const match of config.matchAll(/^\s*base_url\s*=\s*["']([^"']+)["']/gmu)) {
      const value = match[1];
      if (value && value !== baseUrl) candidates.push(candidate(`codex-provider-${candidates.length}`, "codex", "Codex model provider", value, true));
    }
  } catch {
    // A missing config is a valid default Codex installation.
  }

  candidates.push(...await discoverSystemProxy());
  return deduplicate(candidates);
}

export async function diagnoseProxy(candidate: ProxyCandidate, targetUrl = "https://chatgpt.com/"): Promise<ProxyDiagnostic> {
  const startedAt = new Date().toISOString();
  const stages: DiagnosticStage[] = [];
  let proxyUrl: URL;
  try {
    proxyUrl = new URL(candidate.url);
    stages.push(stage("parse", "ok", 0, `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyPort(proxyUrl)}`));
  } catch {
    stages.push(stage("parse", "failed", 0, "Invalid proxy URL"));
    return result(candidate.id, startedAt, stages);
  }

  const dnsStarted = performance.now();
  try {
    const addresses = await dns.lookup(proxyUrl.hostname, { all: true });
    stages.push(stage("dns", "ok", performance.now() - dnsStarted, `${addresses.length} address${addresses.length === 1 ? "" : "es"}`));
  } catch (error) {
    stages.push(stage("dns", "failed", performance.now() - dnsStarted, errorMessage(error)));
    return result(candidate.id, startedAt, stages);
  }

  const tcpStarted = performance.now();
  try {
    await connectTcp(proxyUrl.hostname, proxyPort(proxyUrl), 5_000);
    stages.push(stage("tcp", "ok", performance.now() - tcpStarted, `Connected to port ${proxyPort(proxyUrl)}`));
  } catch (error) {
    stages.push(stage("tcp", "failed", performance.now() - tcpStarted, errorMessage(error)));
    return result(candidate.id, startedAt, stages);
  }

  if (proxyUrl.protocol === "https:") {
    const tlsStarted = performance.now();
    try {
      await connectTls(proxyUrl.hostname, proxyPort(proxyUrl), 5_000);
      stages.push(stage("tls", "ok", performance.now() - tlsStarted, "TLS certificate accepted"));
    } catch (error) {
      stages.push(stage("tls", "failed", performance.now() - tlsStarted, errorMessage(error)));
      return result(candidate.id, startedAt, stages);
    }
  } else {
    stages.push(stage("tls", "skipped", 0, "Proxy transport does not use TLS"));
  }

  const httpStarted = performance.now();
  try {
    const status = await requestThroughProxy(targetUrl, candidate.url, 8_000);
    const ok = status < 500;
    stages.push(stage("http", ok ? "ok" : "failed", performance.now() - httpStarted, `HTTP ${status}`));
  } catch (error) {
    stages.push(stage("http", "failed", performance.now() - httpStarted, errorMessage(error)));
  }
  return result(candidate.id, startedAt, stages);
}

export async function previewCodexBaseUrl(baseUrl: string | null, codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")): Promise<{ before: string; after: string }> {
  const path = join(codexHome, "config.toml");
  const before = await readFile(path, "utf8").catch(() => "");
  return { before: redactConfig(before), after: redactConfig(replaceTomlString(before, "openai_base_url", baseUrl)) };
}

export async function applyCodexBaseUrl(baseUrl: string | null, codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")): Promise<{ backupPath: string }> {
  if (baseUrl) new URL(baseUrl);
  const path = join(codexHome, "config.toml");
  await mkdir(dirname(path), { recursive: true });
  const before = await readFile(path, "utf8").catch(() => "");
  const after = replaceTomlString(before, "openai_base_url", baseUrl);
  const backupDir = join(codexHome, ".codex-monitor-backups");
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `config-${new Date().toISOString().replace(/[:.]/gu, "-")}.toml`);
  if (await exists(path)) await copyFile(path, backupPath);
  else await writeFile(backupPath, "", { mode: 0o600 });
  const tempPath = `${path}.codex-monitor.tmp`;
  await writeFile(tempPath, after, { mode: 0o600 });
  await rename(tempPath, path);
  return { backupPath };
}

export async function restoreCodexConfig(backupPath: string, codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")): Promise<void> {
  const backupRoot = join(codexHome, ".codex-monitor-backups");
  const resolved = join(backupRoot, basename(backupPath));
  if (!resolved.startsWith(backupRoot)) throw new Error("Invalid backup path");
  await copyFile(resolved, join(codexHome, "config.toml"));
}

export interface UserProxyEnvironment {
  http?: string | null;
  https?: string | null;
  all?: string | null;
  noProxy?: string | null;
}

export async function setUserProxyEnvironment(values: UserProxyEnvironment): Promise<{ restartRequired: boolean }> {
  const variables: Record<string, string | null | undefined> = {
    HTTP_PROXY: values.http,
    HTTPS_PROXY: values.https,
    ALL_PROXY: values.all,
    NO_PROXY: values.noProxy,
  };
  for (const value of Object.values(variables)) if (value) new URL(value.includes("://") ? value : `http://${value}`);

  if (platform() === "win32") {
    for (const [key, value] of Object.entries(variables)) {
      if (value) await execFileAsync("setx", [key, value], { windowsHide: true });
      else await execFileAsync("reg", ["delete", "HKCU\\Environment", "/V", key, "/F"], { windowsHide: true }).catch(() => undefined);
    }
    return { restartRequired: true };
  }

  if (platform() === "darwin") {
    for (const [key, value] of Object.entries(variables)) {
      if (value) await execFileAsync("launchctl", ["setenv", key, value]);
      else await execFileAsync("launchctl", ["unsetenv", key]).catch(() => undefined);
    }
    return { restartRequired: true };
  }

  const environmentDir = join(homedir(), ".config", "environment.d");
  const environmentPath = join(environmentDir, "90-codex-monitor.conf");
  const lines = Object.entries(variables).filter((entry): entry is [string, string] => !!entry[1]).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  await mkdir(environmentDir, { recursive: true });
  if (lines.length) await writeFile(environmentPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  else await rm(environmentPath, { force: true });
  return { restartRequired: true };
}

function candidate(id: string, source: ProxySource, label: string, url: string, mutable: boolean, bypass: string[] = []): ProxyCandidate {
  return { id, source, label, url: redactUrl(url), protocol: protocolFor(url), active: true, mutable, bypass };
}

async function discoverSystemProxy(): Promise<ProxyCandidate[]> {
  try {
    if (platform() === "win32") {
      const { stdout } = await execFileAsync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"], { windowsHide: true });
      const value = stdout.match(/ProxyServer\s+REG_SZ\s+(.+)$/mu)?.[1]?.trim();
      return value ? [candidate("system-windows", "system", "Windows user proxy", normalizeProxyUrl(value), false)] : [];
    }
    if (platform() === "darwin") {
      const { stdout } = await execFileAsync("scutil", ["--proxy"]);
      const host = stdout.match(/HTTPProxy\s*:\s*(.+)$/mu)?.[1]?.trim();
      const port = stdout.match(/HTTPPort\s*:\s*(\d+)$/mu)?.[1]?.trim();
      return host ? [candidate("system-macos", "system", "macOS network proxy", `http://${host}:${port ?? "8080"}`, false)] : [];
    }
    const { stdout } = await execFileAsync("gsettings", ["get", "org.gnome.system.proxy.http", "host"]);
    const host = stdout.trim().replace(/^'|'$/gu, "");
    if (!host) return [];
    const portResult = await execFileAsync("gsettings", ["get", "org.gnome.system.proxy.http", "port"]);
    return [candidate("system-linux", "system", "Desktop system proxy", `http://${host}:${portResult.stdout.trim()}`, false)];
  } catch {
    return [];
  }
}

function replaceTomlString(source: string, key: string, value: string | null): string {
  const pattern = new RegExp(`^\\s*${key}\\s*=.*(?:\\r?\\n|$)`, "mu");
  if (value == null || value === "") return source.replace(pattern, "").trimEnd() + (source.trim() ? "\n" : "");
  const line = `${key} = ${JSON.stringify(value)}\n`;
  return pattern.test(source) ? source.replace(pattern, line) : `${line}${source}`;
}

function findTomlString(source: string, key: string): string | null {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "mu"));
  return match?.[1] ?? null;
}

function redactConfig(source: string): string {
  return source.replace(/(token|secret|api_key|bearer)(\s*=\s*)["'][^"']*["']/giu, "$1$2\"••••••••\"");
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(normalizeProxyUrl(raw));
    if (url.username) url.username = "••••";
    if (url.password) url.password = "••••";
    return url.toString();
  } catch {
    return raw.replace(/\/\/[^/@]+@/u, "//••••@ ").trim();
  }
}

function normalizeProxyUrl(raw: string): string {
  return /^[a-z]+:\/\//iu.test(raw) ? raw : `http://${raw}`;
}

function protocolFor(raw: string): ProxyProtocol {
  try {
    const protocol = new URL(normalizeProxyUrl(raw)).protocol.replace(":", "");
    return (["http", "https", "socks4", "socks5"] as string[]).includes(protocol) ? protocol as ProxyProtocol : "unknown";
  } catch {
    return "unknown";
  }
}

function proxyPort(url: URL): number {
  if (url.port) return Number(url.port);
  if (url.protocol === "https:") return 443;
  if (url.protocol.startsWith("socks")) return 1080;
  return 80;
}

function connectTcp(host: string, port: number, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(timeout);
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("Connection timed out")); });
    socket.once("error", reject);
  });
}

function connectTls(host: string, port: number, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, timeout });
    socket.once("secureConnect", () => { socket.destroy(); resolve(); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("TLS handshake timed out")); });
    socket.once("error", reject);
  });
}

function requestThroughProxy(targetUrl: string, proxyUrl: string, timeout: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const client = url.protocol === "http:" ? http : https;
    const request = client.request(url, {
      method: "HEAD",
      agent: new ProxyAgent({ getProxyForUrl: () => proxyUrl }),
      timeout,
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("timeout", () => request.destroy(new Error("HTTP probe timed out")));
    request.once("error", reject);
    request.end();
  });
}

function stage(name: DiagnosticStage["stage"], status: DiagnosticStage["status"], durationMs: number, detail: string): DiagnosticStage {
  return { stage: name, status, durationMs: Math.round(durationMs), detail };
}

function result(candidateId: string, startedAt: string, stages: DiagnosticStage[]): ProxyDiagnostic {
  return { candidateId, startedAt, completedAt: new Date().toISOString(), ok: stages.every((item) => item.status !== "failed"), stages };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/(https?:\/\/)[^/@\s]+@/giu, "$1••••@") : "Unknown error";
}

function splitBypass(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 100);
}

function deduplicate(candidates: ProxyCandidate[]): ProxyCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const key = `${item.source}:${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}
