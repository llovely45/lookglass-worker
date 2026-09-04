import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";

import type {
  CheckStatus,
  MonitorInput,
  OrderItem,
  MonitorRecord,
  PanelInput,
  PanelRecord,
  RawCheckResult,
} from "./types";

type PanelRow = Omit<PanelRecord, "enabled"> & {
  enabled: number | boolean;
};

type MonitorRow = Omit<MonitorRecord, "enabled"> & {
  enabled: number | boolean;
};

type CheckResultRow = Omit<RawCheckResult, "status"> & {
  status: CheckStatus;
};

const PANEL_COLUMNS = `
  id,
  name,
  logo_url,
  sort_order,
  enabled,
  created_at,
  updated_at
`;

const MONITOR_COLUMNS = `
  id,
  panel_id,
  name,
  logo_url,
  link_url,
  kind,
  target,
  port,
  sort_order,
  enabled,
  created_at,
  updated_at
`;

const RESULT_COLUMNS = `
  monitor_id,
  checked_at,
  status,
  latency_ms,
  http_status,
  error_message
`;

const RESULT_INSERT_SQL = `
  INSERT INTO check_results (
    monitor_id,
    checked_at,
    status,
    latency_ms,
    http_status,
    error_message
  ) VALUES (?, ?, ?, ?, ?, ?)
`;

const RESULT_BATCH_SIZE = 100;
const DEFAULT_SCHEDULER_NAME = "scheduler";
const DEFAULT_LEASE_SECONDS = 60;

/** Convert the integer representation used by SQLite into an API boolean. */
function mapSqliteEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function mapPanel(row: PanelRow): PanelRecord {
  return {
    id: row.id,
    name: row.name,
    logo_url: row.logo_url,
    sort_order: row.sort_order,
    enabled: mapSqliteEnabled(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapMonitor(row: MonitorRow): MonitorRecord {
  return {
    id: row.id,
    panel_id: row.panel_id,
    name: row.name,
    logo_url: row.logo_url,
    link_url: row.link_url ?? null,
    kind: row.kind,
    target: row.target,
    port: row.port,
    sort_order: row.sort_order,
    enabled: mapSqliteEnabled(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapCheckResult(row: CheckResultRow): RawCheckResult {
  return {
    monitor_id: row.monitor_id,
    checked_at: row.checked_at,
    status: row.status,
    latency_ms: row.latency_ms,
    http_status: row.http_status,
    error_message: row.error_message,
  };
}

function changed(result: { meta?: { changes?: number } }): boolean {
  return Number(result.meta?.changes ?? 0) > 0;
}

async function listPanelsQuery(
  db: D1Database,
  whereClause: string,
): Promise<PanelRecord[]> {
  const result = await db
    .prepare(
      `SELECT ${PANEL_COLUMNS}
       FROM panels
       ${whereClause}
       ORDER BY sort_order ASC, id ASC`,
    )
    .all<PanelRow>();
  return result.results.map(mapPanel);
}

/** List panels visible to the public status page. */
export async function listPanels(db: D1Database): Promise<PanelRecord[]> {
  return listPanelsQuery(db, "WHERE enabled = 1");
}

/** List all panels for authenticated administration. */
export async function listAllPanels(db: D1Database): Promise<PanelRecord[]> {
  return listPanelsQuery(db, "");
}

export async function getPanel(
  db: D1Database,
  id: string,
): Promise<PanelRecord | null> {
  const result = await db
    .prepare(
      `SELECT ${PANEL_COLUMNS}
       FROM panels
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(id)
    .all<PanelRow>();
  const row = result.results[0];
  return row ? mapPanel(row) : null;
}

export async function listMonitorsByPanel(
  db: D1Database,
  panelId: string,
): Promise<MonitorRecord[]> {
  const result = await db
    .prepare(
      `SELECT ${MONITOR_COLUMNS}
       FROM monitors
       WHERE panel_id = ? AND enabled = 1
       ORDER BY sort_order ASC, id ASC`,
    )
    .bind(panelId)
    .all<MonitorRow>();
  return result.results.map(mapMonitor);
}

/** List monitors eligible for the scheduler and public status output. */
export async function listEnabledMonitors(
  db: D1Database,
): Promise<MonitorRecord[]> {
  const result = await db
    .prepare(
      `SELECT m.id,
              m.panel_id,
              m.name,
              m.logo_url,
              m.link_url,
              m.kind,
              m.target,
              m.port,
              m.sort_order,
              m.enabled,
              m.created_at,
              m.updated_at
       FROM monitors AS m
       INNER JOIN panels AS p ON p.id = m.panel_id
       WHERE m.enabled = 1 AND p.enabled = 1
       ORDER BY p.sort_order ASC, m.sort_order ASC, m.id ASC`,
    )
    .all<MonitorRow>();
  return result.results.map(mapMonitor);
}

export async function listAllMonitors(
  db: D1Database,
): Promise<MonitorRecord[]> {
  const result = await db
    .prepare(
      `SELECT ${MONITOR_COLUMNS}
       FROM monitors
       ORDER BY sort_order ASC, id ASC`,
    )
    .all<MonitorRow>();
  return result.results.map(mapMonitor);
}

export async function listAllMonitorsByPanel(
  db: D1Database,
  panelId: string,
): Promise<MonitorRecord[]> {
  const result = await db
    .prepare(
      `SELECT ${MONITOR_COLUMNS}
       FROM monitors
       WHERE panel_id = ?
       ORDER BY sort_order ASC, id ASC`,
    )
    .bind(panelId)
    .all<MonitorRow>();
  return result.results.map(mapMonitor);
}

export async function getMonitor(
  db: D1Database,
  id: string,
): Promise<MonitorRecord | null> {
  const result = await db
    .prepare(
      `SELECT ${MONITOR_COLUMNS}
       FROM monitors
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(id)
    .all<MonitorRow>();
  const row = result.results[0];
  return row ? mapMonitor(row) : null;
}

export async function insertCheckResults(
  db: D1Database,
  results: readonly RawCheckResult[],
): Promise<void> {
  for (let start = 0; start < results.length; start += RESULT_BATCH_SIZE) {
    const statements: D1PreparedStatement[] = results
      .slice(start, start + RESULT_BATCH_SIZE)
      .map((result) =>
        db
          .prepare(RESULT_INSERT_SQL)
          .bind(
            result.monitor_id,
            result.checked_at,
            result.status,
            result.latency_ms,
            result.http_status,
            result.error_message,
          ),
      );

    if (statements.length > 0) {
      await db.batch(statements);
    }
  }
}

export async function listResultsSince(
  db: D1Database,
  checkedAt: number,
): Promise<RawCheckResult[]> {
  const result = await db
    .prepare(
      `SELECT ${RESULT_COLUMNS}
       FROM check_results
       WHERE checked_at >= ?
       ORDER BY checked_at ASC`,
    )
    .bind(checkedAt)
    .all<CheckResultRow>();
  return result.results.map(mapCheckResult);
}

export async function deleteResultsBefore(
  db: D1Database,
  cutoff: number,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM check_results
       WHERE checked_at < ?`,
    )
    .bind(cutoff)
    .run();
}

export async function insertPanel(
  db: D1Database,
  id: string,
  input: PanelInput,
  nowSeconds: number,
): Promise<PanelRecord> {
  await db
    .prepare(
      `INSERT INTO panels (
        id, name, logo_url, sort_order, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.name,
      input.logo_url,
      input.sort_order,
      input.enabled ? 1 : 0,
      nowSeconds,
      nowSeconds,
    )
    .run();

  return {
    id,
    ...input,
    created_at: nowSeconds,
    updated_at: nowSeconds,
  };
}

export async function updatePanel(
  db: D1Database,
  id: string,
  input: PanelInput,
  nowSeconds: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE panels
       SET name = ?, logo_url = ?, sort_order = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.name,
      input.logo_url,
      input.sort_order,
      input.enabled ? 1 : 0,
      nowSeconds,
      id,
    )
    .run();
  return changed(result);
}

export async function updatePanelOrder(
  db: D1Database,
  items: readonly OrderItem[],
  nowSeconds: number,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  await db.batch(
    items.map((item) =>
      db
        .prepare(
          `UPDATE panels
           SET sort_order = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(item.sort_order, nowSeconds, item.id),
    ),
  );
}

export async function deletePanel(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM check_results
         WHERE monitor_id IN (
           SELECT id FROM monitors WHERE panel_id = ?
         )`,
      )
      .bind(id),
    db.prepare("DELETE FROM monitors WHERE panel_id = ?").bind(id),
    db.prepare("DELETE FROM panels WHERE id = ?").bind(id),
  ]);
  return changed(results.at(-1) ?? {});
}

export async function insertMonitor(
  db: D1Database,
  id: string,
  input: MonitorInput,
  nowSeconds: number,
): Promise<MonitorRecord> {
  await db
    .prepare(
      `INSERT INTO monitors (
        id, panel_id, name, logo_url, link_url, kind, target, port, sort_order,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.panel_id,
      input.name,
      input.logo_url,
      input.link_url,
      input.kind,
      input.target,
      input.port,
      input.sort_order,
      input.enabled ? 1 : 0,
      nowSeconds,
      nowSeconds,
    )
    .run();

  return {
    id,
    ...input,
    created_at: nowSeconds,
    updated_at: nowSeconds,
  };
}

export async function updateMonitor(
  db: D1Database,
  id: string,
  input: MonitorInput,
  nowSeconds: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE monitors
       SET panel_id = ?, name = ?, logo_url = ?, link_url = ?, kind = ?,
           target = ?, port = ?, sort_order = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.panel_id,
      input.name,
      input.logo_url,
      input.link_url,
      input.kind,
      input.target,
      input.port,
      input.sort_order,
      input.enabled ? 1 : 0,
      nowSeconds,
      id,
    )
    .run();
  return changed(result);
}

export async function updateMonitorOrder(
  db: D1Database,
  items: readonly OrderItem[],
  nowSeconds: number,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  await db.batch(
    items.map((item) =>
      db
        .prepare(
          `UPDATE monitors
           SET sort_order = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(item.sort_order, nowSeconds, item.id),
    ),
  );
}

export async function deleteMonitor(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const results = await db.batch([
    db.prepare("DELETE FROM check_results WHERE monitor_id = ?").bind(id),
    db.prepare("DELETE FROM monitors WHERE id = ?").bind(id),
  ]);
  return changed(results.at(-1) ?? {});
}

export function tryAcquireSchedulerLease(
  db: D1Database,
  nowSeconds: number,
  leaseSeconds?: number,
): Promise<boolean>;
export function tryAcquireSchedulerLease(
  db: D1Database,
  name: string,
  nowSeconds: number,
  leaseSeconds?: number,
): Promise<boolean>;
export async function tryAcquireSchedulerLease(
  db: D1Database,
  nameOrNow: string | number,
  nowOrLease?: number,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<boolean> {
  const name = typeof nameOrNow === "string" ? nameOrNow : DEFAULT_SCHEDULER_NAME;
  const nowSeconds = typeof nameOrNow === "string" ? nowOrLease ?? 0 : nameOrNow;
  const duration = typeof nameOrNow === "string"
    ? leaseSeconds
    : nowOrLease ?? DEFAULT_LEASE_SECONDS;
  const leaseUntil = nowSeconds + duration;

  const result = await db
    .prepare(
      `INSERT INTO scheduler_lock (name, lease_until)
       VALUES (?, ?)
       ON CONFLICT (name) DO UPDATE SET lease_until = excluded.lease_until
       WHERE scheduler_lock.lease_until < ?`,
    )
    .bind(name, leaseUntil, nowSeconds)
    .run();
  return changed(result);
}
