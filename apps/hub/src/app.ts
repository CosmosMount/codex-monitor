import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { isDeviceSnapshot } from "@codex-monitor/protocol";
import { HubStore } from "./store.js";

export interface HubOptions {
  databasePath: string;
  secret: string;
  allowOrigin?: string;
}

export async function createHub(options: HubOptions): Promise<{ app: FastifyInstance; store: HubStore }> {
  if (options.secret.length < 16) throw new Error("CODEX_MONITOR_SECRET must contain at least 16 characters");
  const app = Fastify({ logger: true, bodyLimit: 1_048_576 });
  const store = new HubStore(options.databasePath);
  const streams = new Set<NodeJS.WritableStream>();
  await app.register(cors, { origin: options.allowOrigin ?? false });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/api/v1/health") return;
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/iu, "");
    const explicit = request.headers["x-codex-monitor-secret"];
    if (bearer !== options.secret && explicit !== options.secret) return reply.code(401).send({ error: "unauthorized" });
  });

  app.get("/api/v1/health", async () => ({
    ok: true,
    role: "hub",
    schemaVersion: 1,
    revision: store.revision(),
    devices: store.devices().length,
    now: new Date().toISOString(),
  }));

  app.post("/api/v1/ingest", async (request, reply) => {
    if (!isDeviceSnapshot(request.body)) return reply.code(400).send({ error: "invalid_snapshot" });
    const outcome = store.ingest(request.body);
    if (outcome.accepted) broadcast(streams, "stats", store.fleet());
    return { ok: true, ...outcome };
  });

  app.get("/api/v1/stats", async () => store.fleet());

  app.get("/api/v1/stats/stream", async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(`event: snapshot\ndata: ${JSON.stringify(store.fleet())}\n\n`);
    streams.add(response);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 30_000);
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      streams.delete(response);
    });
  });

  app.get("/api/v1/devices", async () => ({ devices: store.devices() }));

  app.patch<{ Params: { id: string }; Body: { name?: string } }>("/api/v1/devices/:id", async (request, reply) => {
    const name = request.body?.name?.trim().slice(0, 80);
    if (!name) return reply.code(400).send({ error: "invalid_name" });
    if (!store.rename(request.params.id, name)) return reply.code(404).send({ error: "not_found" });
    broadcast(streams, "stats", store.fleet());
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/devices/:id", async (request, reply) => {
    if (!store.delete(request.params.id)) return reply.code(404).send({ error: "not_found" });
    broadcast(streams, "stats", store.fleet());
    return { ok: true };
  });

  app.addHook("onClose", async () => store.close());
  return { app, store };
}

function broadcast(streams: Set<NodeJS.WritableStream>, event: string, payload: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const stream of streams) stream.write(message);
}
