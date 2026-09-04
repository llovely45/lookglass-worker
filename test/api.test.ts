import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/api";

const FRONTEND_ORIGIN = "https://frontend.example";
const ADMIN_TOKEN = "admin-token-for-tests";
const SESSION_SECRET = "session-secret-for-tests";

type PreparedCall = {
  sql: string;
  binds: unknown[];
};

class ApiD1Mock {
  readonly prepared: PreparedCall[] = [];

  prepare(sql: string): D1PreparedStatement {
    const call: PreparedCall = { sql, binds: [] };
    this.prepared.push(call);
    const statement = {
      bind: (...values: unknown[]) => {
        call.binds = values;
        return statement;
      },
      all: async <T>() => ({
        results: [] as T[],
        success: true,
        meta: {},
      }),
      run: async () => ({
        success: true,
        meta: { changes: 1 },
      }),
    } as unknown as D1PreparedStatement;
    return statement;
  }

  async batch(statements: D1PreparedStatement[]) {
    return statements.map(() => ({
      success: true,
      meta: { changes: 1 },
    }));
  }
}

function makeEnv(db = new ApiD1Mock()) {
  return {
    env: {
      DB: db as unknown as D1Database,
      ADMIN_TOKEN,
      SESSION_SECRET,
      FRONTEND_ORIGIN,
      R2_PUBLIC_BASE_URL: "https://status.example",
      STATUS_BUCKET: {} as R2Bucket,
    },
    db,
  };
}

function jsonInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

async function login(app: ReturnType<typeof createApp>, env: ReturnType<typeof makeEnv>["env"]): Promise<string> {
  const response = await app.request(
    "/api/auth/login",
    jsonInit({ token: ADMIN_TOKEN }),
    env,
  );
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).not.toBeNull();
  return setCookie!.split(";", 1)[0];
}

describe("Lookglass admin API", () => {
  it("rejects a wrong-token login without setting a cookie", async () => {
    const { env } = makeEnv();
    const app = createApp();

    const response = await app.request(
      "/api/auth/login",
      jsonInit({ token: "wrong-token" }),
      env,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      code: "invalid_credentials",
      message: "invalid credentials",
    });
  });

  it("sets a secure cross-site HttpOnly session cookie for a valid login", async () => {
    const { env } = makeEnv();
    const app = createApp();

    const response = await app.request(
      "/api/auth/login",
      jsonInit({ token: ADMIN_TOKEN }, { Origin: FRONTEND_ORIGIN }),
      env,
    );

    const setCookie = response.headers.get("set-cookie");
    expect(response.status).toBe(200);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=None/i);
    expect(setCookie).toMatch(/Path=\//i);
    expect(setCookie).toMatch(/Max-Age=86400/i);
  });

  it("returns 401 for an unauthenticated admin write", async () => {
    const { env, db } = makeEnv();
    const app = createApp();

    const response = await app.request(
      "/api/admin/panels",
      jsonInit({ name: "Main" }, { Origin: FRONTEND_ORIGIN }),
      env,
    );

    expect(response.status).toBe(401);
    expect(db.prepared).toHaveLength(0);
  });

  it("returns 403 for an admin write from the wrong origin", async () => {
    const { env, db } = makeEnv();
    const app = createApp();
    const cookie = await login(app, env);
    db.prepared.length = 0;

    const response = await app.request(
      "/api/admin/panels",
      jsonInit(
        { name: "Main" },
        { Cookie: cookie, Origin: "https://evil.example" },
      ),
      env,
    );

    expect(response.status).toBe(403);
    expect(db.prepared).toHaveLength(0);
  });

  it("requires an exact Origin for an authenticated admin write", async () => {
    const { env, db } = makeEnv();
    const app = createApp();
    const cookie = await login(app, env);
    db.prepared.length = 0;

    const response = await app.request(
      "/api/admin/panels",
      jsonInit({ name: "Main" }, { Cookie: cookie }),
      env,
    );

    expect(response.status).toBe(403);
    expect(db.prepared).toHaveLength(0);
  });

  it("creates valid panels and monitors", async () => {
    const { env } = makeEnv();
    const app = createApp();
    const cookie = await login(app, env);

    const panelResponse = await app.request(
      "/api/admin/panels",
      jsonInit({ name: "Main" }, { Cookie: cookie, Origin: FRONTEND_ORIGIN }),
      env,
    );
    expect(panelResponse.status).toBe(201);

    const monitorResponse = await app.request(
      "/api/admin/monitors",
      jsonInit(
        {
          panel_id: "panel-1",
          name: "Homepage",
          kind: "http_get",
          target: "https://example.com/health",
          port: null,
        },
        { Cookie: cookie, Origin: FRONTEND_ORIGIN },
      ),
      env,
    );
    expect(monitorResponse.status).toBe(201);
  });

  it("returns 422 for invalid data without a repository write", async () => {
    const { env, db } = makeEnv();
    const app = createApp();
    const cookie = await login(app, env);
    db.prepared.length = 0;

    const response = await app.request(
      "/api/admin/panels",
      jsonInit({ name: "" }, { Cookie: cookie, Origin: FRONTEND_ORIGIN }),
      env,
    );

    expect(response.status).toBe(422);
    expect(db.prepared).toHaveLength(0);
    await expect(response.json()).resolves.toEqual({
      code: "invalid_input",
      message: expect.any(String),
    });
  });

  it("returns the exact configured CORS origin with credentials enabled", async () => {
    const { env } = makeEnv();
    const app = createApp();

    const response = await app.request(
      "/healthz",
      { headers: { Origin: FRONTEND_ORIGIN } },
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(FRONTEND_ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("reports authenticated state and clears the session on logout", async () => {
    const { env } = makeEnv();
    const app = createApp();
    const cookie = await login(app, env);

    const me = await app.request(
      "/api/auth/me",
      { headers: { Cookie: cookie } },
      env,
    );
    expect(me.status).toBe(200);
    const expiresAt = Number(cookie.split("=", 2)[1].split(".")[1]);
    await expect(me.json()).resolves.toEqual({ authenticated: true, expiresAt });

    const logout = await app.request(
      "/api/auth/logout",
      { method: "POST", headers: { Cookie: cookie } },
      env,
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it("supports filtering the admin monitor list by panel_id", async () => {
    const { env, db } = makeEnv();
    const app = createApp();
    const cookie = await login(app, env);
    db.prepared.length = 0;

    const response = await app.request(
      "/api/admin/monitors?panel_id=p1",
      { headers: { Cookie: cookie } },
      env,
    );

    expect(response.status).toBe(200);
    expect(db.prepared[0].sql).toMatch(/FROM\s+monitors/i);
    expect(db.prepared[0].sql).toMatch(/WHERE\s+panel_id\s*=\s*\?/i);
    expect(db.prepared[0].binds).toEqual(["p1"]);
  });
});
