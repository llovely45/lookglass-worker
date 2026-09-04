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
  readonly writes: PreparedCall[] = [];
  readonly batches: PreparedCall[][] = [];
  panelRows: unknown[] = [];
  monitorRows: unknown[] = [];

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
        results: (sql.includes("FROM panels")
          ? this.panelRows
          : sql.includes("FROM monitors")
            ? this.monitorRows
            : []) as T[],
        success: true,
        meta: {},
      }),
      run: async () => {
        this.writes.push(call);
        return {
          success: true,
          meta: { changes: 1 },
        };
      },
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
    jsonInit({ token: ADMIN_TOKEN }, { Origin: FRONTEND_ORIGIN }),
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
      jsonInit({ token: "wrong-token" }, { Origin: FRONTEND_ORIGIN }),
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

  it("rejects a valid-token login from a non-exact Origin", async () => {
    const { env } = makeEnv();
    const app = createApp();

    const response = await app.request(
      "/api/auth/login",
      jsonInit({ token: ADMIN_TOKEN }, { Origin: "https://evil.example" }),
      env,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
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
    const { env, db } = makeEnv();
    const app = createApp();
    const cookie = await login(app, env);
    db.panelRows = [{
      id: "panel-1",
      name: "Main",
      logo_url: null,
      sort_order: 0,
      enabled: 1,
      created_at: 1,
      updated_at: 1,
    }];

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
          link_url: "https://www.example.com/",
        },
        { Cookie: cookie, Origin: FRONTEND_ORIGIN },
      ),
      env,
    );
    expect(monitorResponse.status).toBe(201);
    await expect(monitorResponse.json()).resolves.toMatchObject({
      link_url: "https://www.example.com/",
    });
  });

  it("rejects unknown monitor panel references before POST or PATCH writes", async () => {
    const { env, db } = makeEnv();
    const app = createApp();
    const cookie = await login(app, env);
    const input = {
      panel_id: "missing-panel",
      name: "Homepage",
      kind: "http_get",
      target: "https://example.com/health",
      port: null,
    };

    db.prepared.length = 0;
    db.writes.length = 0;
    const createResponse = await app.request(
      "/api/admin/monitors",
      jsonInit(input, { Cookie: cookie, Origin: FRONTEND_ORIGIN }),
      env,
    );
    expect(createResponse.status).toBe(422);
    expect(db.writes).toHaveLength(0);

    db.prepared.length = 0;
    db.writes.length = 0;
    const updateResponse = await app.request(
      "/api/admin/monitors/m1",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: FRONTEND_ORIGIN,
        },
        body: JSON.stringify(input),
      },
      env,
    );
    expect(updateResponse.status).toBe(422);
    expect(db.writes).toHaveLength(0);
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
      {
        method: "POST",
        headers: { Cookie: cookie, Origin: FRONTEND_ORIGIN },
      },
      env,
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it("requires a valid session and exact Origin for logout", async () => {
    const { env } = makeEnv();
    const app = createApp();

    const unauthenticated = await app.request(
      "/api/auth/logout",
      jsonInit({}, { Origin: FRONTEND_ORIGIN }),
      env,
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("set-cookie")).toBeNull();

    const cookie = await login(app, env);
    const wrongOrigin = await app.request(
      "/api/auth/logout",
      { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example" } },
      env,
    );
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.headers.get("set-cookie")).toBeNull();
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

  it("reorders complete panel and monitor lists in one D1 batch each", async () => {
    const { env, db } = makeEnv();
    const app = createApp();
    const cookie = await login(app, env);
    db.panelRows = [
      {
        id: "p1",
        name: "Primary",
        logo_url: null,
        sort_order: 0,
        enabled: 1,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "p2",
        name: "Backup",
        logo_url: null,
        sort_order: 1,
        enabled: 1,
        created_at: 1,
        updated_at: 1,
      },
    ];
    db.monitorRows = [
      {
        id: "m1",
        panel_id: "p1",
        name: "Homepage",
        logo_url: null,
        kind: "http_get",
        target: "https://example.com/health",
        port: null,
        sort_order: 0,
        enabled: 1,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "m2",
        panel_id: "p1",
        name: "API",
        logo_url: null,
        kind: "http_get",
        target: "https://example.com/api",
        port: null,
        sort_order: 1,
        enabled: 1,
        created_at: 1,
        updated_at: 1,
      },
    ];

    db.prepared.length = 0;
    db.batches.length = 0;
    const panelResponse = await app.request(
      "/api/admin/panels/order",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: FRONTEND_ORIGIN,
        },
        body: JSON.stringify({
          items: [
            { id: "p2", sort_order: 0 },
            { id: "p1", sort_order: 1 },
          ],
        }),
      },
      env,
    );

    expect(panelResponse.status).toBe(200);
    await expect(panelResponse.json()).resolves.toEqual({ reordered: true });
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
    expect(db.batches[0].map(({ sql }) => sql)).toEqual([
      expect.stringMatching(/UPDATE\s+panels/i),
      expect.stringMatching(/UPDATE\s+panels/i),
    ]);
    expect(db.batches[0].map(({ binds }) => [binds[0], binds[2]])).toEqual([
      [0, "p2"],
      [1, "p1"],
    ]);

    db.prepared.length = 0;
    db.batches.length = 0;
    const monitorResponse = await app.request(
      "/api/admin/monitors/order",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: FRONTEND_ORIGIN,
        },
        body: JSON.stringify({
          panel_id: "p1",
          items: [
            { id: "m2", sort_order: 0 },
            { id: "m1", sort_order: 1 },
          ],
        }),
      },
      env,
    );

    expect(monitorResponse.status).toBe(200);
    await expect(monitorResponse.json()).resolves.toEqual({ reordered: true });
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
    expect(db.batches[0].map(({ sql }) => sql)).toEqual([
      expect.stringMatching(/UPDATE\s+monitors/i),
      expect.stringMatching(/UPDATE\s+monitors/i),
    ]);
    expect(db.batches[0].map(({ binds }) => [binds[0], binds[2]])).toEqual([
      [0, "m2"],
      [1, "m1"],
    ]);
  });

  it("rejects invalid, incomplete, duplicate, unknown, and cross-panel order inputs before writes", async () => {
    const { env, db } = makeEnv();
    const app = createApp();
    const cookie = await login(app, env);
    db.panelRows = [
      { id: "p1", sort_order: 0 },
      { id: "p2", sort_order: 1 },
    ];
    db.monitorRows = [
      { id: "m1", panel_id: "p1", sort_order: 0 },
      { id: "m2", panel_id: "p2", sort_order: 0 },
    ];

    const requests = [
      {
        path: "/api/admin/panels/order",
        body: { items: [{ id: "p1", sort_order: 0 }, { id: "p1", sort_order: 1 }] },
      },
      {
        path: "/api/admin/panels/order",
        body: { items: [{ id: "p1", sort_order: 0 }, { id: "missing", sort_order: 1 }] },
      },
      {
        path: "/api/admin/panels/order",
        body: { items: [{ id: "p1", sort_order: 0 }, { id: "p2", sort_order: 0 }] },
      },
      {
        path: "/api/admin/panels/order",
        body: { items: [{ id: "p1", sort_order: 0 }] },
      },
      {
        path: "/api/admin/monitors/order",
        body: {
          panel_id: "p1",
          items: [{ id: "m1", sort_order: 0 }, { id: "m2", sort_order: 1 }],
        },
      },
      {
        path: "/api/admin/monitors/order",
        body: {
          panel_id: "p1",
          items: [{ id: "m1", sort_order: 0 }, { id: "missing", sort_order: 1 }],
        },
      },
      {
        path: "/api/admin/monitors/order",
        body: {
          panel_id: "p1",
          items: [{ id: "m1", sort_order: 0 }, { id: "m1", sort_order: 1 }],
        },
      },
      {
        path: "/api/admin/monitors/order",
        body: {
          panel_id: "p1",
          items: [{ id: "m1", sort_order: 0.5 }],
        },
      },
    ];

    for (const request of requests) {
      db.prepared.length = 0;
      db.writes.length = 0;
      db.batches.length = 0;
      const response = await app.request(
        request.path,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            Origin: FRONTEND_ORIGIN,
          },
          body: JSON.stringify(request.body),
        },
        env,
      );

      expect(response.status, request.path).toBe(422);
      expect(db.writes, request.path).toHaveLength(0);
      expect(db.batches, request.path).toHaveLength(0);
    }
  });
});
