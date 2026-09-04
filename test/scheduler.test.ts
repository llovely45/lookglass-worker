import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";

import {
  runScheduled,
  type SchedulerDeps,
} from "../src/scheduler";
import type {
  MonitorRecord,
  PanelRecord,
  RawCheckResult,
} from "../src/types";

const START = 1_735_689_600;
const MINUTE = START + 60;
const BOUNDARY = START + 1_800;

function panel(): PanelRecord {
  return {
    id: "p1",
    name: "Primary",
    logo_url: null,
    sort_order: 0,
    enabled: true,
    created_at: START,
    updated_at: START,
  };
}

function monitor(id: string): MonitorRecord {
  return {
    id,
    panel_id: "p1",
    name: id,
    logo_url: null,
    kind: "http_get",
    target: `https://${id}.example/health`,
    port: null,
    sort_order: 0,
    enabled: true,
    created_at: START,
    updated_at: START,
  };
}

function checkResult(
  id: string,
  checked_at: number,
  status: RawCheckResult["status"] = "ok",
): RawCheckResult {
  return {
    monitor_id: id,
    checked_at,
    status,
    latency_ms: status === "ok" ? 10 : null,
    http_status: status === "ok" ? 200 : null,
    error_message: status === "ok" ? null : "failed",
  };
}

function baseDeps(monitors: MonitorRecord[] = [monitor("m1")]): {
  deps: SchedulerDeps;
  calls: {
    inserted: RawCheckResult[][];
    cleaned: number[];
    snapshots: unknown[];
    checked: string[];
  };
} {
  const calls = {
    inserted: [] as RawCheckResult[][],
    cleaned: [] as number[],
    snapshots: [] as unknown[],
    checked: [] as string[],
  };
  const deps: SchedulerDeps = {
    tryAcquireSchedulerLease: vi.fn(async () => true),
    listEnabledMonitors: vi.fn(async () => monitors),
    listPanels: vi.fn(async () => [panel()]),
    runCheck: vi.fn(async (config) => {
      calls.checked.push(config.id);
      return checkResult(config.id, MINUTE);
    }),
    insertCheckResults: vi.fn(async (_db, results) => {
      calls.inserted.push([...results]);
    }),
    deleteResultsBefore: vi.fn(async (_db, cutoff) => {
      calls.cleaned.push(cutoff);
    }),
    listResultsSince: vi.fn(async () =>
      monitors.map(({ id }) => checkResult(id, MINUTE)),
    ),
    writeStatusSnapshot: vi.fn(async (_bucket, snapshot) => {
      calls.snapshots.push(snapshot);
    }),
  };
  return { deps, calls };
}

function env() {
  return {
    DB: {} as D1Database,
    STATUS_BUCKET: {} as R2Bucket,
    ADMIN_TOKEN: "unused",
    SESSION_SECRET: "unused",
    FRONTEND_ORIGIN: "https://frontend.example",
    R2_PUBLIC_BASE_URL: "https://status.example",
  };
}

describe("scheduled monitoring", () => {
  it("stores a non-boundary minute and does not write R2", async () => {
    const { deps, calls } = baseDeps();

    await runScheduled(env(), MINUTE * 1_000, deps);

    expect(deps.tryAcquireSchedulerLease).toHaveBeenCalledWith(
      expect.anything(),
      MINUTE,
      55,
    );
    expect(calls.checked).toEqual(["m1"]);
    expect(calls.inserted).toHaveLength(1);
    expect(calls.snapshots).toHaveLength(0);
    expect(calls.cleaned).toEqual([MINUTE - 86_400]);
    expect(deps.listResultsSince).not.toHaveBeenCalled();
  });

  it("writes one R2 snapshot at a half-hour boundary", async () => {
    const { deps, calls } = baseDeps();

    await runScheduled(env(), BOUNDARY * 1_000, deps);

    expect(deps.listResultsSince).toHaveBeenCalledWith(
      expect.anything(),
      BOUNDARY - 86_400,
    );
    expect(deps.writeStatusSnapshot).toHaveBeenCalledOnce();
    expect(calls.snapshots).toHaveLength(1);
  });

  it("skips checks and writes when the scheduler lease is unavailable", async () => {
    const { deps, calls } = baseDeps();
    deps.tryAcquireSchedulerLease = vi.fn(async () => false);

    await runScheduled(env(), MINUTE * 1_000, deps);

    expect(deps.listEnabledMonitors).not.toHaveBeenCalled();
    expect(deps.runCheck).not.toHaveBeenCalled();
    expect(deps.insertCheckResults).not.toHaveBeenCalled();
    expect(deps.deleteResultsBefore).not.toHaveBeenCalled();
    expect(calls.snapshots).toHaveLength(0);
  });

  it("settles a rejected monitor as an error while storing other results", async () => {
    const monitors = [monitor("failed"), monitor("healthy")];
    const { deps, calls } = baseDeps(monitors);
    deps.runCheck = vi.fn(async (config) => {
      if (config.id === "failed") {
        throw new Error("probe exploded");
      }
      return checkResult(config.id, MINUTE);
    });

    await runScheduled(env(), MINUTE * 1_000, deps);

    expect(calls.inserted).toHaveLength(1);
    expect(calls.inserted[0]).toEqual([
      expect.objectContaining({
        monitor_id: "failed",
        checked_at: MINUTE,
        status: "error",
        latency_ms: null,
      }),
      checkResult("healthy", MINUTE),
    ]);
  });

  it("never runs more than ten checks concurrently", async () => {
    const monitors = Array.from({ length: 23 }, (_, index) => monitor(`m${index}`));
    const { deps } = baseDeps(monitors);
    let active = 0;
    let maximum = 0;
    deps.runCheck = vi.fn(async (config) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return checkResult(config.id, MINUTE);
    });

    await runScheduled(env(), MINUTE * 1_000, deps);

    expect(maximum).toBeLessThanOrEqual(10);
    expect(deps.runCheck).toHaveBeenCalledTimes(23);
  });

  it("logs an R2 failure after retaining the D1 results", async () => {
    const { deps, calls } = baseDeps();
    const persistedRows = [
      checkResult("old", BOUNDARY - 86_401, "error"),
    ];
    const error = vi.fn();
    deps.logger = { error };
    deps.insertCheckResults = vi.fn(async (_db, results) => {
      calls.inserted.push([...results]);
      persistedRows.push(...results);
    });
    deps.deleteResultsBefore = vi.fn(async (_db, cutoff) => {
      calls.cleaned.push(cutoff);
      for (let index = persistedRows.length - 1; index >= 0; index -= 1) {
        if (persistedRows[index].checked_at < cutoff) {
          persistedRows.splice(index, 1);
        }
      }
    });
    deps.listResultsSince = vi.fn(async (_db, cutoff) =>
      persistedRows.filter(({ checked_at }) => checked_at >= cutoff),
    );
    deps.writeStatusSnapshot = vi.fn(async () => {
      throw new Error("R2 unavailable");
    });

    await expect(runScheduled(env(), BOUNDARY * 1_000, deps)).resolves.toBeUndefined();

    expect(persistedRows).toEqual([checkResult("m1", MINUTE)]);
    expect(calls.cleaned).toEqual([BOUNDARY - 86_400]);
    expect(error).toHaveBeenCalledOnce();
  });
});
