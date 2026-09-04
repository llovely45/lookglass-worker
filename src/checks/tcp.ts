import {
  validatePublicDestination,
  type PublicDestinationValidationOptions,
} from "../validation";
import type {
  PublicDestinationResolver,
  RawCheckResult,
  ValidationResult,
} from "../types";

const CHECK_TIMEOUT_MS = 10_000;
const MAX_ERROR_MESSAGE_LENGTH = 256;

export interface TcpCheckConfig {
  monitor_id: string;
  target: string;
  port: number;
  checked_at: number;
}

export interface TcpAddress {
  hostname: string;
  port: number;
}

export interface TcpSocketLike {
  readonly opened: Promise<unknown>;
  close(): void | Promise<void>;
}

export type TcpConnector = (
  address: TcpAddress,
) => TcpSocketLike | PromiseLike<TcpSocketLike>;

export interface TcpCheckDeps {
  connector?: TcpConnector;
  resolver?: PublicDestinationResolver;
}

function boundedMessage(error: unknown, fallback: string): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : fallback;
  return (message || fallback).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function result(
  config: TcpCheckConfig,
  status: RawCheckResult["status"],
  latency_ms: number | null,
  error_message: string | null,
): RawCheckResult {
  return {
    monitor_id: config.monitor_id,
    checked_at: config.checked_at,
    status,
    latency_ms,
    http_status: null,
    error_message,
  };
}

const timeoutToken = Symbol("tcp-check-timeout");

async function cloudflareConnector(address: TcpAddress): Promise<TcpSocketLike> {
  const { connect } = await import("cloudflare:sockets");
  return connect(address);
}

async function closeSocket(socket: TcpSocketLike | undefined): Promise<void> {
  if (!socket) {
    return;
  }

  try {
    await socket.close();
  } catch {
    // Preserve the probe result if cleanup itself fails.
  }
}

async function validateTarget(
  target: string,
  deps: TcpCheckDeps,
): Promise<ValidationResult<{ host: string; addresses: string[] }>> {
  const options: PublicDestinationValidationOptions = {};
  if (deps.resolver) {
    options.resolver = deps.resolver;
  }
  return validatePublicDestination(target, options);
}

export async function runTcpCheck(
  config: TcpCheckConfig,
  deps: TcpCheckDeps = {},
): Promise<RawCheckResult> {
  let destination: ValidationResult<{ host: string; addresses: string[] }>;
  try {
    destination = await validateTarget(config.target, deps);
  } catch (error) {
    return result(
      config,
      "error",
      null,
      boundedMessage(error, "destination validation failed"),
    );
  }

  if (!destination.ok) {
    return result(config, "error", null, destination.message);
  }

  const address: TcpAddress = {
    hostname: destination.value.addresses[0],
    port: config.port,
  };
  const connector = deps.connector ?? cloudflareConnector;
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let socket: TcpSocketLike | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeoutToken), CHECK_TIMEOUT_MS);
    });

    socket = await Promise.race([
      Promise.resolve().then(() => connector(address)),
      timeout,
    ]);
    await Promise.race([socket.opened, timeout]);

    const latency = performance.now() - startedAt;
    return result(config, "ok", latency, null);
  } catch (error) {
    if (error === timeoutToken) {
      return result(config, "timeout", null, "TCP connection timed out");
    }

    return result(config, "error", null, boundedMessage(error, "TCP connection failed"));
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    await closeSocket(socket);
  }
}
