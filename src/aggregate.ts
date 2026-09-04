import type {
  CheckStatus,
  MonitorKind,
  MonitorRecord,
  PanelRecord,
  RawCheckResult,
} from "./types";

export const HALF_HOUR_SECONDS = 1_800;
export const RETENTION_SECONDS = 86_400;
export const MAX_BUCKETS = 48;

export interface StatusSample {
  t: number;
  s: CheckStatus | "missing";
  v: number | null;
  code?: number;
}

export interface StatusSnapshot {
  generatedAt: number;
  expiresAt: number;
  intervalSeconds: 1800;
  panels: Array<{
    id: string;
    name: string;
    logoUrl: string | null;
    monitors: Array<{
      id: string;
      name: string;
      logoUrl: string | null;
      linkUrl: string | null;
      kind: MonitorKind;
      target: string;
      samples: StatusSample[];
    }>;
  }>;
}

/** Return the UTC epoch-aligned start of the half-hour containing `seconds`. */
export function halfHourStart(seconds: number): number {
  return Math.floor(seconds / HALF_HOUR_SECONDS) * HALF_HOUR_SECONDS;
}

function compareByOrder(
  left: { sort_order: number; id: string },
  right: { sort_order: number; id: string },
): number {
  return left.sort_order - right.sort_order || left.id.localeCompare(right.id);
}

function bucketStart(checkedAt: number): number {
  return halfHourStart(checkedAt);
}

function sampleFromResult(t: number, result: RawCheckResult): StatusSample {
  const sample: StatusSample = {
    t,
    s: result.status,
    v: result.status === "ok" ? result.latency_ms : null,
  };

  if (typeof result.http_status === "number") {
    sample.code = result.http_status;
  }

  return sample;
}

function aggregateMonitorSamples(
  monitor: MonitorRecord,
  results: readonly RawCheckResult[],
  generatedAt: number,
): StatusSample[] {
  const cutoff = generatedAt - RETENTION_SECONDS;
  const latestByBucket = new Map<number, RawCheckResult>();

  for (const result of results) {
    if (
      result.monitor_id !== monitor.id ||
      result.checked_at < cutoff
    ) {
      continue;
    }

    const bucket = bucketStart(result.checked_at);
    const previous = latestByBucket.get(bucket);
    if (!previous || result.checked_at >= previous.checked_at) {
      latestByBucket.set(bucket, result);
    }
  }

  const buckets = [...latestByBucket.keys()].sort((left, right) => left - right);
  if (buckets.length === 0) {
    return [];
  }

  const latestBucket = buckets[buckets.length - 1];
  const earliestBucket = Math.max(
    buckets[0],
    latestBucket - (MAX_BUCKETS - 1) * HALF_HOUR_SECONDS,
  );
  const samples: StatusSample[] = [];

  for (
    let bucket = earliestBucket;
    bucket <= latestBucket;
    bucket += HALF_HOUR_SECONDS
  ) {
    const result = latestByBucket.get(bucket);
    samples.push(
      result
        ? sampleFromResult(bucket, result)
        : { t: bucket, s: "missing", v: null },
    );
  }

  return samples;
}

export function aggregateResults(
  panels: readonly PanelRecord[],
  monitors: readonly MonitorRecord[],
  results: readonly RawCheckResult[],
  generatedAt: number,
): StatusSnapshot {
  const enabledPanels = panels
    .filter((panel) => panel.enabled)
    .slice()
    .sort(compareByOrder);
  const enabledPanelIds = new Set(enabledPanels.map((panel) => panel.id));
  const enabledMonitors = monitors
    .filter((monitor) => monitor.enabled && enabledPanelIds.has(monitor.panel_id))
    .slice()
    .sort(compareByOrder);
  const monitorsByPanel = new Map<string, MonitorRecord[]>();

  for (const monitor of enabledMonitors) {
    const panelMonitors = monitorsByPanel.get(monitor.panel_id) ?? [];
    panelMonitors.push(monitor);
    monitorsByPanel.set(monitor.panel_id, panelMonitors);
  }

  return {
    generatedAt,
    expiresAt: generatedAt + RETENTION_SECONDS,
    intervalSeconds: HALF_HOUR_SECONDS,
    panels: enabledPanels.map((panel) => ({
      id: panel.id,
      name: panel.name,
      logoUrl: panel.logo_url,
      monitors: (monitorsByPanel.get(panel.id) ?? []).map((monitor) => ({
        id: monitor.id,
        name: monitor.name,
        logoUrl: monitor.logo_url,
        linkUrl: monitor.link_url,
        kind: monitor.kind,
        target: monitor.target,
        samples: aggregateMonitorSamples(monitor, results, generatedAt),
      })),
    })),
  };
}

export function isHalfHourBoundary(seconds: number): boolean {
  if (!Number.isInteger(seconds)) {
    return false;
  }

  // Cloudflare Cron scheduledTime can have a stable second offset from the
  // epoch minute (for example HH:30:20). Match the scheduled UTC minute and
  // keep the snapshot timestamp itself aligned with half-hour epoch buckets.
  return Math.floor(seconds / 60) % 30 === 0;
}
