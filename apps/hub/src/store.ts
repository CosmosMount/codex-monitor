import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { aggregateFleet } from "@codex-monitor/core";
import type { DeviceSnapshot, DeviceStatus, FleetSnapshot } from "@codex-monitor/protocol";

export class HubStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO metadata(key, value) VALUES ('revision', '0');
    `);
  }

  ingest(snapshot: DeviceSnapshot): { accepted: boolean; revision: number } {
    const current = this.database.prepare("SELECT sequence FROM devices WHERE id = ?").get(snapshot.device.id) as { sequence: number } | undefined;
    if (current && current.sequence >= snapshot.sequence) return { accepted: false, revision: this.revision() };
    const receivedAt = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO devices(id, name, sequence, snapshot, received_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, sequence=excluded.sequence, snapshot=excluded.snapshot, received_at=excluded.received_at
      `).run(snapshot.device.id, snapshot.device.name, snapshot.sequence, JSON.stringify(snapshot), receivedAt);
      this.database.prepare("UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'").run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { accepted: true, revision: this.revision() };
  }

  rename(id: string, name: string): boolean {
    const row = this.database.prepare("SELECT snapshot FROM devices WHERE id = ?").get(id) as { snapshot: string } | undefined;
    if (!row) return false;
    const snapshot = JSON.parse(row.snapshot) as DeviceSnapshot;
    snapshot.device.name = name;
    this.database.prepare("UPDATE devices SET name = ?, snapshot = ? WHERE id = ?").run(name, JSON.stringify(snapshot), id);
    this.bumpRevision();
    return true;
  }

  delete(id: string): boolean {
    const result = this.database.prepare("DELETE FROM devices WHERE id = ?").run(id);
    if (Number(result.changes) > 0) this.bumpRevision();
    return Number(result.changes) > 0;
  }

  devices(now = new Date()): DeviceStatus[] {
    return (this.database.prepare("SELECT snapshot, received_at FROM devices ORDER BY name COLLATE NOCASE").all() as Array<{ snapshot: string; received_at: string }>).map((row) => ({
      snapshot: JSON.parse(row.snapshot) as DeviceSnapshot,
      receivedAt: row.received_at,
      stale: now.getTime() - Date.parse(row.received_at) > 5 * 60_000,
    }));
  }

  fleet(): FleetSnapshot {
    return aggregateFleet(this.devices(), this.revision());
  }

  revision(): number {
    const row = this.database.prepare("SELECT value FROM metadata WHERE key = 'revision'").get() as { value: string };
    return Number(row.value);
  }

  prune(days = 370): void {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    for (const device of this.devices()) {
      const snapshot = device.snapshot;
      snapshot.daily = snapshot.daily.filter((entry) => `${entry.date}T23:59:59.999Z` >= cutoff);
      this.database.prepare("UPDATE devices SET snapshot = ? WHERE id = ?").run(JSON.stringify(snapshot), snapshot.device.id);
    }
  }

  close(): void {
    this.database.close();
  }

  private bumpRevision(): void {
    this.database.prepare("UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'").run();
  }
}
