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

export interface HttpCheckConfig {
  monitor_id: string;
  target: string;
  checked_at: number;
}

export interface HttpCheckDeps {
  fetcher?: typeof fetch;
  resolver?: PublicDestinationResolver;
}

const timeoutToken = Symbol("http-check-timeout");

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
  config: HttpCheckConfig,
  status: RawCheckResult["status"],
  latency_ms: number | null,
  http_status: number | null,
  error_message: string | null,
): RawCheckResult {
  return {
    monitor_id: config.monitor_id,
    checked_at: config.checked_at,
    status,
    latency_ms,
    http_status,
    error_message,
  };
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) {
    return;
  }

  try {
    await response.body.cancel();
  } catch {
    // The response has already been received; a body-cancellation failure must
    // not change the status that was observed from the response headers.
  }
}

async function validateTarget(
  target: string,
  deps: HttpCheckDeps,
): Promise<ValidationResult<{ host: string; addresses: string[] }>> {
  const options: PublicDestinationValidationOptions = {};
  if (deps.resolver) {
    options.resolver = deps.resolver;
  }
  return validatePublicDestination(target, options);
}

export async function runHttpCheck(
  config: HttpCheckConfig,
  deps: HttpCheckDeps = {},
): Promise<RawCheckResult> {
  let destination: ValidationResult<{ host: string; addresses: string[] }>;
  try {
    destination = await validateTarget(config.target, deps);
  } catch (error) {
    return result(
      config,
      "error",
      null,
      null,
      boundedMessage(error, "destination validation failed"),
    );
  }

  if (!destination.ok) {
    return result(config, "error", null, null, destination.message);
  }

  const controller = new AbortController();
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutToken);
    }, CHECK_TIMEOUT_MS);
  });
  const fetcher = deps.fetcher ?? fetch;

  try {
    const response = await Promise.race([
      fetcher(config.target, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
      }),
      timeout,
    ]);
    const latency = performance.now() - startedAt;
    await cancelResponseBody(response);

    if (response.status >= 200 && response.status < 400) {
      return result(config, "ok", latency, response.status, null);
    }

    return result(
      config,
      "http_error",
      latency,
      response.status,
      boundedMessage(
        `HTTP request returned status ${response.status}`,
        "HTTP request failed",
      ),
    );
  } catch (error) {
    if (error === timeoutToken || isAbortError(error) || controller.signal.aborted) {
      return result(
        config,
        "timeout",
        null,
        null,
        "HTTP request timed out",
      );
    }

    return result(
      config,
      "error",
      null,
      null,
      boundedMessage(error, "HTTP request failed"),
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
