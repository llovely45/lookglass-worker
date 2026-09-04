PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS panels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  logo_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  logo_url TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('http_get', 'tcping')),
  target TEXT NOT NULL,
  port INTEGER CHECK (
    port IS NULL OR (
      typeof(port) = 'integer' AND port BETWEEN 1 AND 65535
    )
  ),
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS check_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'http_error', 'timeout', 'error')),
  latency_ms REAL,
  http_status INTEGER,
  error_message TEXT,
  CHECK (status <> 'ok' OR latency_ms IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS scheduler_lock (
  name TEXT PRIMARY KEY,
  lease_until INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_check_results_monitor_checked_at
  ON check_results (monitor_id, checked_at);

CREATE INDEX IF NOT EXISTS idx_check_results_checked_at
  ON check_results (checked_at);
