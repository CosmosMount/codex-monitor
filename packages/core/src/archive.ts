import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addUsage, emptyUsage, type DailyUsage, type DeviceSnapshot, type RangeKey, type UsageBreakdown } from "@codex-monitor/protocol";

/** Preserves already-observed daily totals after Codex removes or archives source sessions. */
export class UsageArchive {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS daily_usage_v2 (
        device_id TEXT NOT NULL,
        day TEXT NOT NULL,
        usage TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(device_id, day)
      );
    `);
  }

  merge(snapshot: DeviceSnapshot): DeviceSnapshot {
    const upsert = this.database.prepare(`
      INSERT INTO daily_usage_v2(device_id, day, usage, observed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id, day) DO UPDATE SET usage=excluded.usage, observed_at=excluded.observed_at
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of snapshot.daily) {
        upsert.run(snapshot.device.id, entry.date, JSON.stringify(entry.usage), snapshot.observedAt);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    const daily = (this.database.prepare("SELECT day, usage FROM daily_usage_v2 WHERE device_id = ? ORDER BY day").all(snapshot.device.id) as Array<{ day: string; usage: string }>).map<DailyUsage>((row) => ({ date: row.day, usage: JSON.parse(row.usage) as UsageBreakdown }));
    const periods = { ...snapshot.periods };
    for (const key of ["today", "week", "month", "7d", "30d"] as RangeKey[]) {
      periods[key] = sumRange(daily, key, new Date(snapshot.observedAt));
      periods[key].sessions = Math.max(periods[key].sessions, snapshot.periods[key].sessions);
    }
    periods.all = daily.reduce((sum, entry) => addUsage(sum, entry.usage), emptyUsage());
    periods.all.sessions = snapshot.periods.all.sessions;
    periods.all.turns = Math.max(periods.all.turns, snapshot.periods.all.turns);
    return { ...snapshot, daily, periods };
  }

  close(): void {
    this.database.close();
  }
}

function sumRange(daily: DailyUsage[], range: RangeKey, now: Date): UsageBreakdown {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (range === "month") start.setDate(1);
  if (range === "7d") start.setDate(start.getDate() - 6);
  if (range === "30d") start.setDate(start.getDate() - 29);
  return daily.filter((entry) => new Date(`${entry.date}T00:00:00`) >= start).reduce((sum, entry) => addUsage(sum, entry.usage), emptyUsage());
}
