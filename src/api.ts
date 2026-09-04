import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  createSessionCookie,
  getSessionExpiration,
  SESSION_COOKIE_MAX_AGE,
  SESSION_COOKIE_NAME,
  verifySessionCookie,
} from "./auth";
import {
  deleteMonitor,
  deletePanel,
  getMonitor,
  getPanel,
  insertMonitor,
  insertPanel,
  listAllMonitors,
  listAllMonitorsByPanel,
  listAllPanels,
  updateMonitor,
  updatePanel,
} from "./db";
import { corsMiddleware, exactOriginMiddleware } from "./cors";
import type { Env } from "./types";
import { validateMonitorInput, validatePanelInput } from "./validation";

type AppEnv = { Bindings: Env };
type AppContext = Context<AppEnv>;
type App = Hono<AppEnv>;

const JSON_HEADERS = { "Content-Type": "application/json" };

function errorResponse(
  c: AppContext,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  return c.json({ code, message }, status, JSON_HEADERS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(
  c: AppContext,
): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function constantTimeTokenMatch(value: unknown, expected: string): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const actualBytes = new TextEncoder().encode(value);
  const expectedBytes = new TextEncoder().encode(expected);
  let difference = actualBytes.length ^ expectedBytes.length;
  const length = Math.max(actualBytes.length, expectedBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (actualBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}

function extractCookieValue(
  cookieHeader: string | undefined,
): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  const acceptedNames = new Set([SESSION_COOKIE_NAME, "session"]);
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (acceptedNames.has(name)) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function sessionCookieHeader(value: string, maxAge: number): string {
  return `${SESSION_COOKIE_NAME}=${value}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None; Path=/`;
}

const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const cookie = extractCookieValue(c.req.header("Cookie"));
  const valid = await verifySessionCookie(
    cookie,
    c.env.SESSION_SECRET,
    Date.now(),
  );
  if (!valid) {
    return errorResponse(c, 401, "unauthorized", "authentication required");
  }
  await next();
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function newId(): string {
  return crypto.randomUUID();
}

export function createApp(): App {
  const app = new Hono<AppEnv>();

  app.use("*", corsMiddleware);
  app.use("/api/auth/login", exactOriginMiddleware);
  app.use("/api/auth/logout", exactOriginMiddleware);
  app.use("/api/auth/logout", sessionMiddleware);

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.post("/api/auth/login", async (c) => {
    const body = await readJson(c);
    const token = isRecord(body) ? body.token : undefined;
    if (!constantTimeTokenMatch(token, c.env.ADMIN_TOKEN)) {
      return errorResponse(c, 401, "invalid_credentials", "invalid credentials");
    }

    const value = await createSessionCookie(c.env.SESSION_SECRET, Date.now());
    c.header("Set-Cookie", sessionCookieHeader(value, SESSION_COOKIE_MAX_AGE));
    return c.json({ authenticated: true });
  });

  app.post("/api/auth/logout", (c) => {
    c.header("Set-Cookie", sessionCookieHeader("", 0));
    return c.json({ authenticated: false });
  });

  app.get("/api/auth/me", async (c) => {
    const cookie = extractCookieValue(c.req.header("Cookie"));
    const valid = await verifySessionCookie(
      cookie,
      c.env.SESSION_SECRET,
      Date.now(),
    );
    if (!valid) {
      return errorResponse(c, 401, "unauthorized", "authentication required");
    }
    const expiresAt = getSessionExpiration(cookie);
    if (expiresAt === null) {
      return errorResponse(c, 401, "unauthorized", "authentication required");
    }
    return c.json({ authenticated: true, expiresAt });
  });

  app.use("/api/admin/*", exactOriginMiddleware);
  app.use("/api/admin/*", sessionMiddleware);

  app.get("/api/admin/panels", async (c) => {
    return c.json(await listAllPanels(c.env.DB));
  });

  app.post("/api/admin/panels", async (c) => {
    const body = await readJson(c);
    if (body === undefined) {
      return errorResponse(c, 422, "invalid_json", "request body must be valid JSON");
    }

    const validation = validatePanelInput(body);
    if (!validation.ok) {
      return errorResponse(c, 422, "invalid_input", validation.message);
    }

    const panel = await insertPanel(c.env.DB, newId(), validation.value, nowSeconds());
    return c.json(panel, 201);
  });

  app.get("/api/admin/panels/:id", async (c) => {
    const panel = await getPanel(c.env.DB, c.req.param("id"));
    if (!panel) {
      return errorResponse(c, 404, "not_found", "panel not found");
    }
    return c.json(panel);
  });

  const savePanel: MiddlewareHandler<AppEnv> = async (c) => {
    const body = await readJson(c);
    if (body === undefined) {
      return errorResponse(c, 422, "invalid_json", "request body must be valid JSON");
    }

    const validation = validatePanelInput(body);
    if (!validation.ok) {
      return errorResponse(c, 422, "invalid_input", validation.message);
    }

    const id = c.req.param("id") ?? "";
    const updated = await updatePanel(c.env.DB, id, validation.value, nowSeconds());
    if (!updated) {
      return errorResponse(c, 404, "not_found", "panel not found");
    }
    return c.json({ id, ...validation.value, updated_at: nowSeconds() });
  };

  app.put("/api/admin/panels/:id", savePanel);
  app.patch("/api/admin/panels/:id", savePanel);

  app.delete("/api/admin/panels/:id", async (c) => {
    const deleted = await deletePanel(c.env.DB, c.req.param("id"));
    if (!deleted) {
      return errorResponse(c, 404, "not_found", "panel not found");
    }
    return c.json({ deleted: true });
  });

  app.get("/api/admin/monitors", async (c) => {
    const panelId = c.req.query("panel_id");
    return c.json(
      panelId === undefined
        ? await listAllMonitors(c.env.DB)
        : await listAllMonitorsByPanel(c.env.DB, panelId),
    );
  });

  app.post("/api/admin/monitors", async (c) => {
    const body = await readJson(c);
    if (body === undefined) {
      return errorResponse(c, 422, "invalid_json", "request body must be valid JSON");
    }

    const validation = validateMonitorInput(body);
    if (!validation.ok) {
      return errorResponse(c, 422, "invalid_input", validation.message);
    }

    const panel = await getPanel(c.env.DB, validation.value.panel_id);
    if (!panel) {
      return errorResponse(c, 422, "invalid_input", "panel_id references an unknown panel");
    }

    const monitor = await insertMonitor(
      c.env.DB,
      newId(),
      validation.value,
      nowSeconds(),
    );
    return c.json(monitor, 201);
  });

  app.get("/api/admin/monitors/:id", async (c) => {
    const monitor = await getMonitor(c.env.DB, c.req.param("id"));
    if (!monitor) {
      return errorResponse(c, 404, "not_found", "monitor not found");
    }
    return c.json(monitor);
  });

  const saveMonitor: MiddlewareHandler<AppEnv> = async (c) => {
    const body = await readJson(c);
    if (body === undefined) {
      return errorResponse(c, 422, "invalid_json", "request body must be valid JSON");
    }

    const validation = validateMonitorInput(body);
    if (!validation.ok) {
      return errorResponse(c, 422, "invalid_input", validation.message);
    }

    const panel = await getPanel(c.env.DB, validation.value.panel_id);
    if (!panel) {
      return errorResponse(c, 422, "invalid_input", "panel_id references an unknown panel");
    }

    const id = c.req.param("id") ?? "";
    const updated = await updateMonitor(c.env.DB, id, validation.value, nowSeconds());
    if (!updated) {
      return errorResponse(c, 404, "not_found", "monitor not found");
    }
    return c.json({ id, ...validation.value, updated_at: nowSeconds() });
  };

  app.put("/api/admin/monitors/:id", saveMonitor);
  app.patch("/api/admin/monitors/:id", saveMonitor);

  app.delete("/api/admin/monitors/:id", async (c) => {
    const deleted = await deleteMonitor(c.env.DB, c.req.param("id"));
    if (!deleted) {
      return errorResponse(c, 404, "not_found", "monitor not found");
    }
    return c.json({ deleted: true });
  });

  app.notFound((c) => errorResponse(c, 404, "not_found", "resource not found"));
  app.onError((_error, c) =>
    errorResponse(c, 500, "internal_error", "internal server error"));

  return app;
}
