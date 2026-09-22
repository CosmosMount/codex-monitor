import { createHash } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { hostname } from "node:os";

const DISCOVERY_PORT = 17_322;
const DISCOVERY_GROUP = "239.255.77.77";
const QUERY = "CODEX_MONITOR_DISCOVER_V1";

export interface DiscoveredHub {
  id: string;
  name: string;
  url: string;
  address: string;
  port: number;
}

export interface LanHubAdvertiser {
  close(): Promise<void>;
}

export async function startLanHubAdvertiser(options: { port: number; name?: string; id?: string }): Promise<LanHubAdvertiser> {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  const name = (options.name?.trim() || `${hostname()} Codex Monitor`).slice(0, 80);
  const id = options.id ?? createHash("sha256").update(`${hostname()}|${options.port}`).digest("hex").slice(0, 20);
  socket.on("message", (message, remote) => {
    if (message.toString("utf8") !== QUERY) return;
    const payload = Buffer.from(JSON.stringify({ type: "codex-monitor-hub", schemaVersion: 1, id, name, port: options.port }));
    socket.send(payload, remote.port, remote.address, () => undefined);
  });
  await bindSocket(socket, DISCOVERY_PORT);
  socket.setBroadcast(true);
  try { socket.addMembership(DISCOVERY_GROUP); } catch { /* Broadcast discovery remains available. */ }
  return { close: () => closeSocket(socket) };
}

export async function discoverLanHubs(timeoutMs = 1_200): Promise<DiscoveredHub[]> {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  const hubs = new Map<string, DiscoveredHub>();
  socket.on("message", (message, remote) => {
    try {
      const value = JSON.parse(message.toString("utf8")) as Partial<{ type: string; schemaVersion: number; id: string; name: string; port: number }>;
      if (value.type !== "codex-monitor-hub" || value.schemaVersion !== 1 || typeof value.port !== "number" || value.port < 1 || value.port > 65_535) return;
      const address = remote.address.replace(/^::ffff:/u, "");
      const id = typeof value.id === "string" && value.id ? value.id : `${address}:${value.port}`;
      hubs.set(id, { id, name: typeof value.name === "string" && value.name ? value.name : address, url: `http://${address}:${value.port}`, address, port: value.port });
    } catch { /* Ignore unrelated LAN packets. */ }
  });
  await bindSocket(socket, 0);
  socket.setBroadcast(true);
  socket.setMulticastTTL(1);
  const query = Buffer.from(QUERY);
  await Promise.allSettled([
    send(socket, query, DISCOVERY_PORT, DISCOVERY_GROUP),
    send(socket, query, DISCOVERY_PORT, "255.255.255.255"),
  ]);
  await new Promise((resolve) => setTimeout(resolve, Math.max(200, Math.min(timeoutMs, 5_000))));
  await closeSocket(socket);
  return [...hubs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function bindSocket(socket: Socket, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    socket.once("error", onError);
    socket.bind(port, "0.0.0.0", () => {
      socket.off("error", onError);
      socket.on("error", () => undefined);
      resolve();
    });
  });
}

function send(socket: Socket, payload: Buffer, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => socket.send(payload, port, address, (error) => error ? reject(error) : resolve()));
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    try { socket.close(() => resolve()); } catch { resolve(); }
  });
}
