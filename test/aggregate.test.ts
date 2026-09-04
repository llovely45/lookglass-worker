import { describe, expect, it, vi } from "vitest";

import {
  aggregateResults,
  halfHourStart,
  isHalfHourBoundary,
  type StatusSnapshot,
} from "../src/aggregate";
import { writeStatusSnapshot } from "../src/r2";
import type {
  CheckStatus,
  MonitorRecord,
  PanelRecord,
  RawCheckResult,
} from "../src/types";

const START = 1_735_689_600;
const NOW = START + 86_400;
const CUTOFF = NOW - 86_400;

function panel(
  id: string,
  enabled = true,
  sort_order = 0,
): PanelRecord {
  return {
    id,
    name: `Panel ${id}`,
    logo_url: null,
    sort_order,
    enabled,
    created_at: START,
    updated_at: START,
  };
}

function monitor(
  id: string,
  panel_id = "p1",
  enabled = true,
  sort_order = 0,
  link_url: string | null = null,
): MonitorRecord {
  return {
    id,
    panel_id,
    name: `Monitor ${id}`,
    logo_url: null,
    link_url,
    kind: "http_get",
    target: `https://${id}.example/health`,
    port: null,
    sort_order,
    enabled,
    created_at: START,
    updated_at: START,
  };
}

function result(
  monitor_id: string,
  checked_at: number,
  status: CheckStatus = "ok",
  latency_ms: number | null = 450,
  http_status: number | null = 200,
): RawCheckResult {
  return {
    monitor_id,
    checked_at,
    status,
    latency_ms,
    http_status,
    error_message: status === "ok" ? null : "probe failed",
  };
}

async function sha256Etag(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

describe("half-hour status aggregation", () => {
  it("keeps the result with the greatest checked_at in one bucket", () => {
    const snapshot = aggregateResults(
      [panel("p1")],
      [monitor("m1")],
      [
        result("m1", START + 30, "ok", 120, 200),
        result("m1", START + 299, "ok", 450, 200),
      ],
      START + 900,
    );

    expect(snapshot.panels[0].monitors[0].samples).toEqual([
      { t: START, s: "ok", v: 450, code: 200 },
    ]);
  });

  it("uses a null value for failed samples and fills a missing bucket", () => {
    const snapshot = aggregateResults(
      [panel("p1")],
      [monitor("m1")],
      [
        result("m1", START + 1, "timeout", 999, null),
        result("m1", START + 3_601, "ok", 50, 200),
      ],
      START + 3_700,
    );

    expect(snapshot.panels[0].monitors[0].samples).toEqual([
      { t: START, s: "timeout", v: null },
      { t: START + 1_800, s: "missing", v: null },
      { t: START + 3_600, s: "ok", v: 50, code: 200 },
    ]);
  });

  it("omits disabled panels and monitors from the public snapshot", () => {
    const snapshot = aggregateResults(
      [panel("p1"), panel("p2", false)],
      [monitor("active", "p1"), monitor("disabled", "p1", false), monitor("hidden", "p2")],
      [
        result("active", START + 1),
        result("disabled", START + 1),
        result("hidden", START + 1),
      ],
      START + 900,
    );

    expect(snapshot.panels).toHaveLength(1);
    expect(snapshot.panels[0].id).toBe("p1");
    expect(snapshot.panels[0].monitors.map(({ id }) => id)).toEqual(["active"]);
  });

  it("includes the configured monitor navigation link in the public snapshot", () => {
    const linkUrl = "https://www.example.com/";
    const snapshot = aggregateResults(
      [panel("p1")],
      [monitor("m1", "p1", true, 0, linkUrl)],
      [],
      START,
    );

    expect(snapshot.panels[0].monitors[0]).toMatchObject({ linkUrl });
  });

  it("includes the exact 24-hour cutoff and excludes older rows", () => {
    const snapshot = aggregateResults(
      [panel("p1")],
      [monitor("m1")],
      [
        result("m1", CUTOFF - 1),
        result("m1", CUTOFF),
      ],
      NOW,
    );

    expect(snapshot.panels[0].monitors[0].samples).toEqual([
      { t: CUTOFF, s: "ok", v: 450, code: 200 },
    ]);
    expect(snapshot.expiresAt).toBe(NOW + 86_400);
  });

  it("keeps no more than 48 ascending buckets", () => {
    const results = Array.from({ length: 49 }, (_, index) =>
      result("m1", CUTOFF + index * 1_800),
    );
    const snapshot = aggregateResults(
      [panel("p1")],
      [monitor("m1")],
      results,
      NOW,
    );
    const samples = snapshot.panels[0].monitors[0].samples;

    expect(samples).toHaveLength(48);
    expect(samples[0].t).toBe(CUTOFF + 1_800);
    expect(samples.at(-1)?.t).toBe(CUTOFF + 48 * 1_800);
    expect(samples.map(({ t }) => t)).toEqual(
      [...samples].map(({ t }) => t).sort((left, right) => left - right),
    );
  });

  it("identifies UTC half-hour boundaries", () => {
    expect(isHalfHourBoundary(START)).toBe(true);
    expect(isHalfHourBoundary(START + 1_799)).toBe(false);
    expect(isHalfHourBoundary(START + 1_800)).toBe(true);
    expect(isHalfHourBoundary(START + 1_820)).toBe(true);
    expect(halfHourStart(START + 1_820)).toBe(START + 1_800);
  });
});

describe("R2 status snapshot writes", () => {
  it("writes the exact public key and public cache metadata", async () => {
    const put = vi.fn(async () => ({}) as never);
    const bucket = { put } as unknown as R2Bucket;
    const snapshot: StatusSnapshot = {
      generatedAt: NOW,
      expiresAt: NOW + 86_400,
      intervalSeconds: 1_800,
      panels: [
        {
          id: "p1",
          name: "Panel p1",
          logoUrl: null,
          monitors: [
            {
              id: "m1",
              name: "Monitor m1",
              logoUrl: null,
              linkUrl: null,
              kind: "http_get",
              target: "https://m1.example/health",
              samples: [{ t: NOW, s: "ok", v: 450, code: 200 }],
            },
          ],
        },
      ],
    };

    await writeStatusSnapshot(bucket, snapshot);

    expect(put).toHaveBeenCalledOnce();
    const [key, body, options] = put.mock.calls[0] as unknown as [
      string,
      string,
      { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> },
    ];
    expect(key).toBe("public/status.json");
    expect(JSON.parse(body)).toEqual(snapshot);
    expect(body).not.toMatch(/checked_at|latency_ms|minute/i);
    expect(options.httpMetadata).toEqual({
      contentType: "application/json",
      cacheControl: "public, max-age=30, must-revalidate",
    });
    expect(options.customMetadata?.etag).toBe(await sha256Etag(body));
  });
});
