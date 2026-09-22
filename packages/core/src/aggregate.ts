import {
  SCHEMA_VERSION,
  addUsage,
  emptyUsage,
  type DeviceStatus,
  type DimensionUsage,
  type FleetSnapshot,
  type RangeKey,
  type UsageBreakdown,
} from "@codex-monitor/protocol";

export function aggregateFleet(devices: DeviceStatus[], revision: number, now = new Date()): FleetSnapshot {
  const periods = Object.fromEntries((["today", "week", "month", "7d", "30d", "all"] as RangeKey[]).map((key) => [key, emptyUsage()])) as Record<RangeKey, UsageBreakdown>;
  const daily = new Map<string, UsageBreakdown>();
  const models = new Map<string, UsageBreakdown>();
  const projects = new Map<string, { label: string; usage: UsageBreakdown }>();

  for (const device of devices) {
    for (const key of Object.keys(periods) as RangeKey[]) addUsage(periods[key], device.snapshot.periods[key]);
    for (const entry of device.snapshot.daily) addUsageMap(daily, entry.date, entry.usage);
    for (const entry of device.snapshot.models) addUsageMap(models, entry.id, entry.usage);
    for (const entry of device.snapshot.projects) {
      const current = projects.get(entry.id) ?? { label: entry.label, usage: emptyUsage() };
      addUsage(current.usage, entry.usage);
      projects.set(entry.id, current);
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    revision,
    generatedAt: now.toISOString(),
    periods,
    daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, usage]) => ({ date, usage })),
    models: mapDimensions(models),
    projects: [...projects.entries()].map(([id, value]) => ({ id, label: value.label, usage: value.usage })).sort(byTokens),
    sessions: devices.flatMap((device) => device.snapshot.sessions.map((session) => ({
      ...session,
      deviceId: device.snapshot.device.id,
      deviceName: device.snapshot.device.name,
    }))).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)).slice(0, 10_000),
    devices,
    limits: devices.flatMap((device) => device.snapshot.limits ? [{ deviceId: device.snapshot.device.id, deviceName: device.snapshot.device.name, status: device.snapshot.limits }] : []),
  };
}

function addUsageMap(map: Map<string, UsageBreakdown>, key: string, usage: UsageBreakdown): void {
  const current = map.get(key) ?? emptyUsage();
  addUsage(current, usage);
  map.set(key, current);
}

function mapDimensions(map: Map<string, UsageBreakdown>): DimensionUsage[] {
  return [...map.entries()].map(([id, usage]) => ({ id, label: id, usage })).sort(byTokens);
}

function byTokens(a: DimensionUsage, b: DimensionUsage): number {
  return b.usage.totalTokens - a.usage.totalTokens;
}
