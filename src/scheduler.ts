import {
  aggregateResults,
  halfHourStart,
  isHalfHourBoundary,
  RETENTION_SECONDS,
  type StatusSnapshot,
} from "./aggregate";
import { runCheck } from "./checks";
import {
  deleteResultsBefore,
  insertCheckResults,
  listEnabledMonitors,
  listPanels,
  listResultsSince,
  tryAcquireSchedulerLease,
} from "./db";
import { writeStatusSnapshot } from "./r2";
import type { Env, MonitorRecord, PanelRecord, RawCheckResult } from "./types";

const SCHEDULER_LEASE_SECONDS = 55;
const MAX_CONCURRENT_CHECKS = 10;
const MAX_ERROR_MESSAGE_LENGTH = 256;

export interface SchedulerDeps {
  listEnabledMonitors?: typeof listEnabledMonitors;
  listPanels?: typeof listPanels;
  insertCheckResults?: typeof insertCheckResults;
  listResultsSince?: typeof listResultsSince;
  deleteResultsBefore?: typeof deleteResultsBefore;
  tryAcquireSchedulerLease?: typeof tryAcquireSchedulerLease;
  runCheck?: typeof runCheck;
  writeStatusSnapshot?: typeof writeStatusSnapshot;
  bucket?: R2Bucket;
  logger?: Pick<Console, "error">;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "monitor check failed";
  return (message || "monitor check failed").slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function failedResult(
  monitor: MonitorRecord,
  checkedAt: number,
  error: unknown,
): RawCheckResult {
  return {
    monitor_id: monitor.id,
    checked_at: checkedAt,
    status: "error",
    latency_ms: null,
    http_status: null,
    error_message: errorMessage(error),
  };
}

async function runChecksBounded(
  monitors: readonly MonitorRecord[],
  checkedAt: number,
  checker: typeof runCheck,
): Promise<RawCheckResult[]> {
  const results = new Array<RawCheckResult>(monitors.length);
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= monitors.length) {
        return;
      }

      const monitor = monitors[index];
      try {
        results[index] = await checker(monitor);
      } catch (error) {
        results[index] = failedResult(monitor, checkedAt, error);
      }
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT_CHECKS, monitors.length);
  await Promise.allSettled(
    Array.from({ length: workerCount }, () => consume()),
  );
  return results;
}

export async function runScheduled(
  env: Env,
  scheduledTimeMs: number,
  deps: SchedulerDeps = {},
): Promise<void> {
  const scheduledSeconds = Math.floor(scheduledTimeMs / 1_000);
  const acquireLease = deps.tryAcquireSchedulerLease ?? tryAcquireSchedulerLease;
  const acquired = await acquireLease(
    env.DB,
    scheduledSeconds,
    SCHEDULER_LEASE_SECONDS,
  );
  if (!acquired) {
    return;
  }

  const listMonitors = deps.listEnabledMonitors ?? listEnabledMonitors;
  const monitors = await listMonitors(env.DB);
  const readPanels = deps.listPanels ?? listPanels;
  const panels = await readPanels(env.DB);
  const onlyNavigationPanelIds = new Set(
    panels.filter((panel) => panel.nav_only).map((panel) => panel.id),
  );
  const scheduledMonitors = monitors.filter(
    (monitor) => !onlyNavigationPanelIds.has(monitor.panel_id),
  );
  const checker = deps.runCheck ?? runCheck;
  const results = await runChecksBounded(
    scheduledMonitors,
    scheduledSeconds,
    checker,
  );

  const insertResults = deps.insertCheckResults ?? insertCheckResults;
  await insertResults(env.DB, results);

  const shouldWriteSnapshot = isHalfHourBoundary(scheduledSeconds);
  const snapshotGeneratedAt = shouldWriteSnapshot
    ? halfHourStart(scheduledSeconds)
    : scheduledSeconds;
  const cutoff = snapshotGeneratedAt - RETENTION_SECONDS;
  const deleteOldResults = deps.deleteResultsBefore ?? deleteResultsBefore;
  await deleteOldResults(env.DB, cutoff);

  if (!shouldWriteSnapshot) {
    return;
  }

  const readResults = deps.listResultsSince ?? listResultsSince;
  const storedResults = await readResults(env.DB, cutoff);
  const snapshot: StatusSnapshot = aggregateResults(
    panels as readonly PanelRecord[],
    monitors,
    storedResults,
    snapshotGeneratedAt,
  );

  const writeSnapshot = deps.writeStatusSnapshot ?? writeStatusSnapshot;
  try {
    await writeSnapshot(deps.bucket ?? env.STATUS_BUCKET, snapshot);
  } catch (error) {
    (deps.logger ?? console).error("failed to write status snapshot", error);
  }
}

export { MAX_CONCURRENT_CHECKS, SCHEDULER_LEASE_SECONDS };
