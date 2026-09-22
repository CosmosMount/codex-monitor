import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DeviceSnapshot } from "@codex-monitor/protocol";

export class SnapshotQueue {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly maxItems = 1_000) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS upload_queue (
        sequence INTEGER PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queue_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO queue_metadata(key, value) VALUES ('last_sequence', '0');
      UPDATE queue_metadata
      SET value = CAST(MAX(CAST(value AS INTEGER), (SELECT COALESCE(MAX(sequence), 0) FROM upload_queue)) AS TEXT)
      WHERE key = 'last_sequence';
    `);
  }

  enqueue(snapshot: DeviceSnapshot): void {
    this.database.prepare("INSERT OR REPLACE INTO upload_queue(sequence, payload, created_at) VALUES (?, ?, ?)")
      .run(snapshot.sequence, JSON.stringify(snapshot), new Date().toISOString());
    this.database.prepare("UPDATE queue_metadata SET value = CAST(MAX(CAST(value AS INTEGER), ?) AS TEXT) WHERE key = 'last_sequence'")
      .run(snapshot.sequence);
    this.database.prepare(`DELETE FROM upload_queue WHERE sequence IN (
      SELECT sequence FROM upload_queue ORDER BY sequence DESC LIMIT -1 OFFSET ?
    )`).run(this.maxItems);
  }

  list(): DeviceSnapshot[] {
    return (this.database.prepare("SELECT payload FROM upload_queue ORDER BY sequence ASC").all() as Array<{ payload: string }>)
      .map((row) => JSON.parse(row.payload) as DeviceSnapshot);
  }

  acknowledge(sequence: number): void {
    this.database.prepare("DELETE FROM upload_queue WHERE sequence <= ?").run(sequence);
  }

  lastSequence(): number {
    const row = this.database.prepare("SELECT value FROM queue_metadata WHERE key = 'last_sequence'").get() as { value: string };
    return Number(row.value) || 0;
  }

  size(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM upload_queue").get() as { count: number };
    return Number(row.count);
  }

  clear(): void {
    this.database.prepare("DELETE FROM upload_queue").run();
  }

  close(): void {
    this.database.close();
  }
}
