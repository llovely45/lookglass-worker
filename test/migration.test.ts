import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../migrations/0001_initial.sql", import.meta.url),
);
const linkMigrationPath = fileURLToPath(
  new URL("../migrations/0002_monitor_link_url.sql", import.meta.url),
);

describe("initial D1 migration", () => {
  it("declares all required tables and columns", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS panels/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS monitors/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS check_results/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS scheduler_lock/i);

    for (const column of [
      "id",
      "name",
      "logo_url",
      "sort_order",
      "enabled",
      "created_at",
      "updated_at",
    ]) {
      expect(sql).toMatch(new RegExp(`\\b${column}\\b`, "i"));
    }
    for (const column of [
      "panel_id",
      "kind",
      "target",
      "port",
    ]) {
      expect(sql).toMatch(new RegExp(`\\b${column}\\b`, "i"));
    }
    for (const column of [
      "monitor_id",
      "checked_at",
      "latency_ms",
      "http_status",
      "error_message",
    ]) {
      expect(sql).toMatch(new RegExp(`\\b${column}\\b`, "i"));
    }
    expect(sql).toMatch(/scheduler_lock[\s\S]*?name\s+TEXT\s+PRIMARY KEY/i);
    expect(sql).toMatch(/lease_until\s+INTEGER\s+NOT NULL/i);
  });

  it("declares the monitor/time indexes, foreign keys, and status checks", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_check_results_monitor_checked_at[\s\S]*?\(\s*monitor_id\s*,\s*checked_at\s*\)/i,
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_check_results_checked_at[\s\S]*?\(\s*checked_at\s*\)/i,
    );
    expect(sql).toMatch(/REFERENCES panels\s*\(\s*id\s*\)[\s\S]*?ON DELETE CASCADE/i);
    expect(sql).toMatch(/REFERENCES monitors\s*\(\s*id\s*\)[\s\S]*?ON DELETE CASCADE/i);
    expect(sql).toMatch(
      /CHECK\s*\(\s*kind\s+IN\s*\(\s*'http_get'\s*,\s*'tcping'\s*\)\s*\)/i,
    );

    for (const status of ["ok", "http_error", "timeout", "error"]) {
      expect(sql).toMatch(new RegExp(`'${status}'`, "i"));
    }
    expect(sql).toMatch(
      /CHECK\s*\(\s*status\s+IN\s*\(\s*'ok'[\s\S]*?'http_error'[\s\S]*?'timeout'[\s\S]*?'error'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /port\s+INTEGER[\s\S]*?CHECK\s*\(\s*port\s+IS\s+NULL\s+OR\s+\(\s*typeof\(port\)\s*=\s*'integer'[\s\S]*?port\s+BETWEEN\s+1\s+AND\s+65535\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /status\s+TEXT[\s\S]*?latency_ms\s+REAL[\s\S]*?CHECK\s*\(\s*status\s*<>\s*'ok'\s+OR\s+latency_ms\s+IS\s+NOT\s+NULL\s*\)/i,
    );
  });
});

describe("monitor navigation link migration", () => {
  it("adds a nullable link_url column without changing existing monitor rows", () => {
    expect(existsSync(linkMigrationPath)).toBe(true);
    const sql = readFileSync(linkMigrationPath, "utf8");

    expect(sql).toMatch(
      /ALTER TABLE\s+monitors\s+ADD COLUMN\s+link_url\s+TEXT/i,
    );
  });
});
