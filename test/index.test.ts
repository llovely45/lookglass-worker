import type {
  D1Database,
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/types";

const { runScheduledMock } = vi.hoisted(() => ({
  runScheduledMock: vi.fn(async () => undefined),
}));

vi.mock("../src/scheduler", () => ({
  runScheduled: runScheduledMock,
}));

const { fetch, scheduled } = await import("../src/index");

const FRONTEND_ORIGIN = "https://frontend.example";
const ADMIN_TOKEN = "local-admin-token";
const SESSION_SECRET = "local-session-secret";

function env(): Env {
  return {
    DB: {} as D1Database,
    STATUS_BUCKET: {} as R2Bucket,
    FRONTEND_ORIGIN,
    R2_PUBLIC_BASE_URL: "https://status.example",
    ADMIN_TOKEN,
    SESSION_SECRET,
  };
}

const executionContext = {} as ExecutionContext;

describe("Worker module handlers", () => {
  beforeEach(() => {
    runScheduledMock.mockClear();
  });

  it("serves the health check through the exported fetch handler", async () => {
    const response = await fetch(
      new Request("https://worker.example/healthz"),
      env(),
      executionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("routes login through the Hono app and returns a session", async () => {
    const response = await fetch(
      new Request("https://worker.example/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: FRONTEND_ORIGIN,
        },
        body: JSON.stringify({ token: ADMIN_TOKEN }),
      }),
      env(),
      executionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: true });
    expect(response.headers.get("set-cookie")).toMatch(
      /^lookglass_session=/,
    );
  });

  it("passes the Cron scheduled time unchanged to the scheduler", async () => {
    const scheduledTime = 1_800_000_123_456;
    const workerEnv = env();

    await scheduled(
      { scheduledTime } as ScheduledController,
      workerEnv,
      executionContext,
    );

    expect(runScheduledMock).toHaveBeenCalledOnce();
    expect(runScheduledMock).toHaveBeenCalledWith(workerEnv, scheduledTime);
  });
});
