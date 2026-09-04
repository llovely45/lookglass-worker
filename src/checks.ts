import { runHttpCheck } from "./checks/http";
import type { HttpCheckConfig, HttpCheckDeps } from "./checks/http";
import { runTcpCheck } from "./checks/tcp";
import type { TcpCheckConfig, TcpCheckDeps } from "./checks/tcp";
import type { MonitorRecord, RawCheckResult } from "./types";

export { runHttpCheck } from "./checks/http";
export type { HttpCheckConfig, HttpCheckDeps } from "./checks/http";
export { runTcpCheck } from "./checks/tcp";
export type {
  TcpAddress,
  TcpCheckConfig,
  TcpCheckDeps,
  TcpConnector,
  TcpSocketLike,
} from "./checks/tcp";

export interface CheckDeps extends HttpCheckDeps, TcpCheckDeps {}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function errorResult(
  monitorId: string,
  checkedAt: number,
  message: string,
): RawCheckResult {
  return {
    monitor_id: monitorId,
    checked_at: checkedAt,
    status: "error",
    latency_ms: null,
    http_status: null,
    error_message: message,
  };
}

export async function runCheck(
  config: MonitorRecord,
  deps: CheckDeps = {},
): Promise<RawCheckResult> {
  const checkedAt = nowSeconds();

  switch (config.kind) {
    case "http_get": {
      const httpConfig: HttpCheckConfig = {
        monitor_id: config.id,
        target: config.target,
        checked_at: checkedAt,
      };
      return runHttpCheck(httpConfig, deps);
    }
    case "tcping": {
      if (
        typeof config.port !== "number" ||
        !Number.isInteger(config.port) ||
        config.port < 1 ||
        config.port > 65535
      ) {
        return errorResult(config.id, checkedAt, "invalid TCP monitor port");
      }

      const tcpConfig: TcpCheckConfig = {
        monitor_id: config.id,
        target: config.target,
        port: config.port,
        checked_at: checkedAt,
      };
      return runTcpCheck(tcpConfig, deps);
    }
    default:
      return errorResult(config.id, checkedAt, "unsupported monitor kind");
  }
}
