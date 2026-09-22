import type { DeviceSnapshot, FleetSnapshot } from "@codex-monitor/protocol";
import type { SnapshotQueue } from "./queue.js";

export type HubSyncPhase = "idle" | "connecting" | "connected" | "reconnecting" | "error";

export interface HubSyncStatus {
  phase: HubSyncPhase;
  hubUrl: string;
  queued: number;
  lastReceivedAt: string | null;
  error: string | null;
}

export interface HubSyncClientOptions {
  hubUrl: string;
  secret: string;
  queue: SnapshotQueue;
  onFleet?: (fleet: FleetSnapshot) => void;
  onStatus?: (status: HubSyncStatus) => void;
  fetchImpl?: typeof fetch;
  subscribe?: boolean;
}

export class HubSyncClient {
  readonly hubUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly controller = new AbortController();
  private stopped = false;
  private flushPromise: Promise<void> | null = null;
  private streamPromise: Promise<void> | null = null;
  private lastReceivedAt: string | null = null;

  constructor(private readonly options: HubSyncClientOptions) {
    this.hubUrl = options.hubUrl.replace(/\/+$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  start(): void {
    if (this.streamPromise) return;
    if (this.options.subscribe === false) {
      this.streamPromise = this.flush().then(() => this.emit("connected", null)).catch((error) => this.emit("error", error instanceof Error ? error.message : String(error)));
    } else {
      this.streamPromise = this.streamLoop();
    }
  }

  async push(snapshot: DeviceSnapshot): Promise<void> {
    this.options.queue.enqueue(snapshot);
    try {
      await this.flush();
      if (this.options.subscribe === false) this.emit("connected", null);
    } catch (error) {
      if (this.options.subscribe === false) this.emit("error", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async refreshFleet(): Promise<FleetSnapshot> {
    const response = await this.request("/api/v1/stats");
    if (!response.ok) throw new Error(`Hub returned HTTP ${response.status}`);
    return await response.json() as FleetSnapshot;
  }

  async renameDevice(id: string, name: string): Promise<void> {
    const response = await this.request(`/api/v1/devices/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    if (!response.ok) throw new Error(`Hub returned HTTP ${response.status}`);
  }

  async deleteDevice(id: string): Promise<void> {
    const response = await this.request(`/api/v1/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Hub returned HTTP ${response.status}`);
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
    this.emit("idle", null);
  }

  private async flush(): Promise<void> {
    do {
      this.flushPromise ??= this.flushPending().finally(() => { this.flushPromise = null; });
      await this.flushPromise;
    } while (!this.stopped && this.options.queue.size() > 0);
  }

  private async flushPending(): Promise<void> {
    for (const pending of this.options.queue.list()) {
      const response = await this.request("/api/v1/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pending),
      });
      if (!response.ok) throw new Error(`Hub rejected snapshot: HTTP ${response.status}`);
      this.options.queue.acknowledge(pending.sequence);
      this.emit("connecting", null);
    }
  }

  private async streamLoop(): Promise<void> {
    let firstAttempt = true;
    while (!this.stopped) {
      try {
        this.emit(firstAttempt ? "connecting" : "reconnecting", null);
        await this.flush();
        const response = await this.request("/api/v1/stats/stream", { headers: { accept: "text/event-stream" } }, 0);
        if (!response.ok || !response.body) throw new Error(`Hub stream returned HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!this.stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const messages = buffer.split(/\r?\n\r?\n/u);
          buffer = messages.pop() ?? "";
          for (const message of messages) {
            const data = message.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const fleet = JSON.parse(data) as FleetSnapshot;
            this.lastReceivedAt = new Date().toISOString();
            this.emit("connected", null);
            this.options.onFleet?.(fleet);
          }
        }
        if (!this.stopped) throw new Error("Hub stream closed");
      } catch (error) {
        if (this.stopped) break;
        this.emit("error", error instanceof Error ? error.message : String(error));
        await delay(2_000);
      }
      firstAttempt = false;
    }
  }

  private request(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
    const signal = timeoutMs > 0 ? AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)]) : this.controller.signal;
    return this.fetchImpl(`${this.hubUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.options.secret}`, ...init.headers },
      signal,
    });
  }

  private emit(phase: HubSyncPhase, error: string | null): void {
    this.options.onStatus?.({ phase, hubUrl: this.hubUrl, queued: this.options.queue.size(), lastReceivedAt: this.lastReceivedAt, error });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
