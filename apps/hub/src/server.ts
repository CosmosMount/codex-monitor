import { join } from "node:path";
import { createHub } from "./app.js";

const port = Number(process.env.PORT ?? 17_321);
const host = process.env.HOST ?? "0.0.0.0";
const secret = process.env.CODEX_MONITOR_SECRET ?? "";
const databasePath = process.env.CODEX_MONITOR_DATA_PATH ?? join(process.cwd(), "data", "hub.sqlite");

const allowOrigin = process.env.CODEX_MONITOR_ALLOW_ORIGIN;
const { app, store } = await createHub({ databasePath, secret, ...(allowOrigin ? { allowOrigin } : {}) });
store.prune(Number(process.env.CODEX_MONITOR_RETENTION_DAYS ?? 370));
await app.listen({ host, port });
