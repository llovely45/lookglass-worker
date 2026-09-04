import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";

import {
  deleteMonitor,
  deletePanel,
  deleteResultsBefore,
  insertCheckResults,
  listEnabledMonitors,
  listMonitorsByPanel,
  listPanels,
  listResultsSince,
  tryAcquireSchedulerLease,
} from "../src/db";

type PreparedCall = {
  sql: string;
  binds: unknown[];
};

class SmallD1Mock {
  readonly prepared: PreparedCall[] = [];
  readonly batches: PreparedCall[][] = [];
  rows: unknown[] = [];
  runChanges: number[] = [];

  prepare(sql: string): D1PreparedStatement {
    const call: PreparedCall = { sql, binds: [] };
    this.prepared.push(call);
    const statement = {
      get sql() {
        return call.sql;
      },
      get binds() {
        return call.binds;
      },
      bind: (...values: unknown[]) => {
        call.binds = values;
        return statement;
      },
      all: async <T>() => ({
        results: this.rows as T[],
        success: true,
        meta: {},
      }),
      run: async () => ({
        success: true,
        meta: { changes: this.runChanges.shift() ?? 1 },
      }),
    } as unknown as D1PreparedStatement;
    return statement;
  }

  async batch(statements: D1PreparedStatement[]) {
    this.batches.push(
      statements.map((statement) => {
        const prepared = statement as unknown as {
          sql?: string;
          binds?: unknown[];
        };
        return {
          sql: prepared.sql ?? "",
          binds: prepared.binds ?? [],
        };
      }),
    );
    return statements.map(() => ({
      success: true,
      meta: { changes: 1 },
    }));
  }
}

function asD1(mock: SmallD1Mock): D1Database {
  return mock as unknown as D1Database;
}

describe("D1 repositories", () => {
  it("lists enabled panels in sort order and maps SQLite booleans", async () => {
    const db = new SmallD1Mock();
    db.rows = [
      {
        id: "p1",
        name: "Primary",
        logo_url: null,
        sort_order: 2,
        enabled: 1,
        created_at: 10,
        updated_at: 11,
      },
    ];

    await expect(listPanels(asD1(db))).resolves.toEqual([
      {
        id: "p1",
        name: "Primary",
        logo_url: null,
        sort_order: 2,
        enabled: true,
        created_at: 10,
        updated_at: 11,
      },
    ]);
    expect(db.prepared[0].sql).toMatch(/WHERE\s+enabled\s*=\s*1/i);
    expect(db.prepared[0].sql).toMatch(/ORDER BY\s+sort_order\s+ASC/i);
  });

  it("lists enabled monitors for a panel in sort order", async () => {
    const db = new SmallD1Mock();
    db.rows = [
      {
        id: "m1",
        panel_id: "p1",
        name: "Homepage",
        logo_url: null,
        kind: "http_get",
        target: "https://example.com/health",
        port: null,
        sort_order: 1,
        enabled: 1,
        created_at: 10,
        updated_at: 11,
      },
    ];

    await expect(listMonitorsByPanel(asD1(db), "p1")).resolves.toEqual([
      {
        id: "m1",
        panel_id: "p1",
        name: "Homepage",
        logo_url: null,
        kind: "http_get",
        target: "https://example.com/health",
        port: null,
        sort_order: 1,
        enabled: true,
        created_at: 10,
        updated_at: 11,
      },
    ]);
    expect(db.prepared[0].sql).toMatch(/panel_id\s*=\s*\?/i);
    expect(db.prepared[0].sql).toMatch(/enabled\s*=\s*1/i);
    expect(db.prepared[0].sql).toMatch(/ORDER BY\s+sort_order\s+ASC/i);
    expect(db.prepared[0].binds).toEqual(["p1"]);
  });

  it("lists enabled monitors and maps result rows to typed records", async () => {
    const db = new SmallD1Mock();
    db.rows = [
      {
        id: "m1",
        panel_id: "p1",
        name: "DNS",
        logo_url: "https://example.com/logo.png",
        kind: "tcping",
        target: "8.8.8.8",
        port: 53,
        sort_order: 3,
        enabled: 1,
        created_at: 10,
        updated_at: 11,
      },
    ];

    await expect(listEnabledMonitors(asD1(db))).resolves.toMatchObject([
      { id: "m1", enabled: true, sort_order: 3 },
    ]);
    expect(db.prepared[0].sql).toMatch(/WHERE\s+[^;]*enabled\s*=\s*1/i);
    expect(db.prepared[0].sql).toMatch(/ORDER BY\s+[^;]*sort_order\s+ASC/i);
  });

  it("binds every result column and inserts results in a batch", async () => {
    const db = new SmallD1Mock();
    const row = {
      monitor_id: "m1",
      checked_at: 1735689600,
      status: "ok" as const,
      latency_ms: 42,
      http_status: 200,
      error_message: null,
    };

    await insertCheckResults(asD1(db), [row]);

    expect(db.batches).toHaveLength(1);
    expect(db.prepared[0].binds).toEqual([
      row.monitor_id,
      row.checked_at,
      row.status,
      row.latency_ms,
      row.http_status,
      row.error_message,
    ]);
    expect(db.prepared[0].sql).toMatch(
      /INSERT INTO\s+check_results[\s\S]*monitor_id[\s\S]*checked_at[\s\S]*status[\s\S]*latency_ms[\s\S]*http_status[\s\S]*error_message/i,
    );
  });

  it("lists results since the supplied timestamp", async () => {
    const db = new SmallD1Mock();
    db.rows = [
      {
        monitor_id: "m1",
        checked_at: 1735689600,
        status: "ok",
        latency_ms: 42,
        http_status: 200,
        error_message: null,
      },
    ];

    await expect(listResultsSince(asD1(db), 1735689500)).resolves.toEqual(db.rows);
    expect(db.prepared[0].sql).toMatch(/checked_at\s*>=\s*\?/i);
    expect(db.prepared[0].binds).toEqual([1735689500]);
  });

  it("deletes only results older than the supplied cutoff", async () => {
    const db = new SmallD1Mock();
    await deleteResultsBefore(asD1(db), 1735689600);

    expect(db.prepared[0].sql).toMatch(
      /DELETE FROM\s+check_results[\s\S]*checked_at\s*<\s*\?/i,
    );
    expect(db.prepared[0].binds).toEqual([1735689600]);
  });

  it("deletes a panel's results before its monitors and panel in one batch", async () => {
    const db = new SmallD1Mock();

    await expect(deletePanel(asD1(db), "p1")).resolves.toBe(true);

    expect(db.batches).toHaveLength(1);
    expect(db.batches[0].map(({ sql }) => sql)).toEqual([
      expect.stringMatching(/DELETE FROM\s+check_results/i),
      expect.stringMatching(/DELETE FROM\s+monitors/i),
      expect.stringMatching(/DELETE FROM\s+panels/i),
    ]);
    expect(db.batches[0].map(({ binds }) => binds)).toEqual([
      ["p1"],
      ["p1"],
      ["p1"],
    ]);
  });

  it("deletes a monitor's results before its monitor in one batch", async () => {
    const db = new SmallD1Mock();

    await expect(deleteMonitor(asD1(db), "m1")).resolves.toBe(true);

    expect(db.batches).toHaveLength(1);
    expect(db.batches[0].map(({ sql }) => sql)).toEqual([
      expect.stringMatching(/DELETE FROM\s+check_results/i),
      expect.stringMatching(/DELETE FROM\s+monitors/i),
    ]);
    expect(db.batches[0].map(({ binds }) => binds)).toEqual([["m1"], ["m1"]]);
  });

  it("uses an atomic insert-or-update lease and reports whether it was acquired", async () => {
    const db = new SmallD1Mock();
    db.runChanges = [1, 0];

    await expect(tryAcquireSchedulerLease(asD1(db), 1735689600, 60)).resolves.toBe(true);
    await expect(tryAcquireSchedulerLease(asD1(db), 1735689600, 60)).resolves.toBe(false);

    const lease = db.prepared[0];
    expect(lease.sql).toMatch(/INSERT INTO\s+scheduler_lock/i);
    expect(lease.sql).toMatch(/ON CONFLICT\s*\(\s*name\s*\)\s*DO UPDATE/i);
    expect(lease.sql).toMatch(/lease_until\s*<\s*\?/i);
    expect(lease.binds).toContain(1735689600);
  });
});
