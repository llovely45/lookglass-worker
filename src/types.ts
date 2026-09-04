export interface Env {
  DB: D1Database;
  STATUS_BUCKET: R2Bucket;
  ADMIN_TOKEN: string;
  SESSION_SECRET: string;
  FRONTEND_ORIGIN: string;
  R2_PUBLIC_BASE_URL: string;
}

export type MonitorKind = "http_get" | "tcping";

export type CheckStatus = "ok" | "http_error" | "timeout" | "error";

export interface PanelRecord {
  id: string;
  name: string;
  logo_url: string | null;
  sort_order: number;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface MonitorRecord {
  id: string;
  panel_id: string;
  name: string;
  logo_url: string | null;
  kind: MonitorKind;
  target: string;
  port: number | null;
  sort_order: number;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface PanelInput {
  name: string;
  logo_url: string | null;
  sort_order: number;
  enabled: boolean;
}

export interface MonitorInput {
  panel_id: string;
  name: string;
  logo_url: string | null;
  kind: MonitorKind;
  target: string;
  port: number | null;
  sort_order: number;
  enabled: boolean;
}

export interface PublicDestination {
  host: string;
  addresses: string[];
}

export type PublicDestinationResolver = (
  hostname: string,
) => Promise<readonly string[]>;

export interface RawCheckResult {
  monitor_id: string;
  checked_at: number;
  status: CheckStatus;
  latency_ms: number | null;
  http_status: number | null;
  error_message: string | null;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };
