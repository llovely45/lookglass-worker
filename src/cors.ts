import type { Context, MiddlewareHandler } from "hono";

import type { Env } from "./types";

type AppEnv = { Bindings: Env };
type AppContext = Context<AppEnv>;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function addCorsHeaders(c: AppContext): void {
  const origin = c.req.header("Origin");
  if (!origin || origin !== c.env.FRONTEND_ORIGIN) {
    return;
  }

  c.header("Access-Control-Allow-Origin", c.env.FRONTEND_ORIGIN);
  c.header("Access-Control-Allow-Credentials", "true");
  c.header("Access-Control-Allow-Headers", "Content-Type, Cookie");
  c.header(
    "Access-Control-Allow-Methods",
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  c.header("Vary", "Origin");
}

export const corsMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  addCorsHeaders(c);

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  await next();
};

/** Reject cross-site state-changing requests before they reach admin routes. */
export const exactOriginMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header("Origin");
  if (
    WRITE_METHODS.has(c.req.method) &&
    origin !== c.env.FRONTEND_ORIGIN
  ) {
    return c.json(
      { code: "origin_forbidden", message: "origin is not allowed" },
      403,
    );
  }

  await next();
};
