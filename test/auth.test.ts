import { describe, expect, it } from "vitest";

import {
  createSessionCookie,
  verifySessionCookie,
} from "../src/auth";

const SESSION_SECRET = "unit-test-session-secret";
const NOW_MS = 1_735_689_600_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe("signed session cookies", () => {
  it("creates a URL-safe cookie that verifies while fresh", async () => {
    const cookie = await createSessionCookie(SESSION_SECRET, NOW_MS);

    expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[0-9]+\.[A-Za-z0-9_-]+$/);
    await expect(
      verifySessionCookie(cookie, SESSION_SECRET, NOW_MS + DAY_MS - 1),
    ).resolves.toBe(true);
  });

  it("rejects missing, malformed, and expired cookies", async () => {
    await expect(
      verifySessionCookie(undefined, SESSION_SECRET, NOW_MS),
    ).resolves.toBe(false);
    await expect(
      verifySessionCookie("not-a-session", SESSION_SECRET, NOW_MS),
    ).resolves.toBe(false);

    const expired = await createSessionCookie(SESSION_SECRET, NOW_MS);
    await expect(
      verifySessionCookie(expired, SESSION_SECRET, NOW_MS + DAY_MS),
    ).resolves.toBe(false);
  });

  it("rejects a cookie whose signed value has been altered", async () => {
    const cookie = await createSessionCookie(SESSION_SECRET, NOW_MS);
    const altered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;

    await expect(
      verifySessionCookie(altered, SESSION_SECRET, NOW_MS),
    ).resolves.toBe(false);
  });
});
