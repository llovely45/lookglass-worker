import { describe, expect, it } from "vitest";

import {
  isPublicDestination,
  validateHttpTarget,
  validateMonitorInput,
  validatePanelInput,
  validateTcpTarget,
} from "../src/validation";

const validHttpMonitor = {
  panel_id: "panel-1",
  name: "Homepage",
  kind: "http_get",
  target: "https://example.com/health",
  port: null,
};

const validTcpMonitor = {
  panel_id: "panel-1",
  name: "DNS",
  kind: "tcping",
  target: "8.8.8.8",
  port: 53,
};

describe("public destination validation", () => {
  it("accepts a complete HTTPS URL", () => {
    expect(validateHttpTarget("https://example.com/health")).toEqual({
      ok: true,
      value: "https://example.com/health",
    });
  });

  it("accepts a complete HTTP URL", () => {
    expect(validateHttpTarget("http://example.com:8080/status").ok).toBe(true);
  });

  it("rejects non-HTTP URL schemes", () => {
    expect(validateHttpTarget("ftp://example.com").ok).toBe(false);
    expect(validateHttpTarget("data:text/plain,hello").ok).toBe(false);
  });

  it("rejects URL credentials", () => {
    expect(validateHttpTarget("https://user:password@example.com/health").ok).toBe(
      false,
    );
    expect(validateHttpTarget("https://@example.com/health").ok).toBe(false);
  });

  it("rejects local HTTP destinations", () => {
    expect(validateHttpTarget("http://127.0.0.1/health").ok).toBe(false);
    expect(validateHttpTarget("http://localhost/health").ok).toBe(false);
  });

  it("accepts a public TCP hostname", () => {
    expect(validateTcpTarget("monitor.example.com", 443)).toEqual({
      ok: true,
      host: "monitor.example.com",
      port: 443,
    });
  });

  it("accepts public IPv4 and IPv6 literals", () => {
    expect(validateTcpTarget("8.8.8.8", 53).ok).toBe(true);
    expect(validateTcpTarget("2001:4860:4860::8888", 53).ok).toBe(true);
  });

  it.each([
    ["localhost", "localhost name"],
    ["127.0.0.1", "IPv4 loopback"],
    ["::1", "IPv6 loopback"],
    ["169.254.1.1", "IPv4 link-local"],
    ["fe80::1", "IPv6 link-local"],
    ["10.0.0.1", "RFC1918 10/8"],
    ["172.16.0.1", "RFC1918 172.16/12"],
    ["192.168.1.1", "RFC1918 192.168/16"],
    ["224.0.0.1", "IPv4 multicast"],
    ["ff02::1", "IPv6 multicast"],
    ["0.0.0.0", "IPv4 unspecified"],
    ["::", "IPv6 unspecified"],
    ["192.0.2.1", "IPv4 documentation"],
    ["198.51.100.1", "IPv4 documentation"],
    ["203.0.113.1", "IPv4 documentation"],
    ["2001:db8::1", "IPv6 documentation"],
    ["2001:2::1", "IPv6 benchmarking"],
    ["3fff::1", "IPv6 documentation"],
    ["::8.8.8.8", "IPv4-compatible IPv6"],
    ["::ffff:192.168.1.1", "mapped RFC1918"],
    ["169.254.169.254", "cloud metadata"],
    ["metadata.google.internal", "metadata hostname"],
  ])("rejects %s (%s)", (destination) => {
    expect(isPublicDestination(destination)).toBe(false);
    expect(validateTcpTarget(destination, 443).ok).toBe(false);
  });

  it("rejects malformed or embedded TCP host values", () => {
    expect(validateTcpTarget("999.999.999.999", 443).ok).toBe(false);
    expect(validateTcpTarget("example.com:443", 443).ok).toBe(false);
    expect(validateTcpTarget("[::1]:443", 443).ok).toBe(false);
    expect(validateTcpTarget("[8.8.8.8]", 443).ok).toBe(false);
    expect(validateTcpTarget("1.2.3.4::", 443).ok).toBe(false);
  });

  it.each([0, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "443"]) (
    "rejects invalid TCP port %s",
    (port) => {
      expect(validateTcpTarget("example.com", port).ok).toBe(false);
    },
  );

  it("accepts a bracketed public IPv6 TCP literal", () => {
    expect(validateTcpTarget("[2001:4860:4860::8888]", 443)).toEqual({
      ok: true,
      host: "2001:4860:4860::8888",
      port: 443,
    });
  });
});

describe("panel input validation", () => {
  it("requires a non-empty panel name", () => {
    expect(validatePanelInput({ name: "   " }).ok).toBe(false);
  });

  it("rejects control characters before trimming a panel name", () => {
    expect(validatePanelInput({ name: "\nMain" }).ok).toBe(false);
    expect(validatePanelInput({ name: "Main\t" }).ok).toBe(false);
  });

  it("normalizes optional panel fields", () => {
    expect(validatePanelInput({ name: "Main" })).toEqual({
      ok: true,
      value: {
        name: "Main",
        logo_url: null,
        sort_order: 0,
        enabled: true,
      },
    });
  });

  it("only accepts HTTPS public logo URLs", () => {
    expect(
      validatePanelInput({
        name: "Main",
        logo_url: "https://example.com/logo.png",
      }).ok,
    ).toBe(true);
    expect(
      validatePanelInput({
        name: "Main",
        logo_url: "http://example.com/logo.png",
      }).ok,
    ).toBe(false);
  });
});

describe("monitor input validation", () => {
  it("accepts an HTTP monitor with a null port", () => {
    expect(validateMonitorInput(validHttpMonitor)).toEqual({
      ok: true,
      value: {
        ...validHttpMonitor,
        logo_url: null,
        sort_order: 0,
        enabled: true,
      },
    });
  });

  it("accepts a TCPing monitor with an integer port", () => {
    expect(validateMonitorInput(validTcpMonitor)).toEqual({
      ok: true,
      value: {
        ...validTcpMonitor,
        logo_url: null,
        sort_order: 0,
        enabled: true,
      },
    });
  });

  it("accepts only the supported monitor kinds", () => {
    expect(validateMonitorInput(validHttpMonitor).ok).toBe(true);
    expect(validateMonitorInput(validTcpMonitor).ok).toBe(true);
    expect(
      validateMonitorInput({ ...validHttpMonitor, kind: "icmp" }).ok,
    ).toBe(false);
  });

  it("requires a null port for HTTP monitors", () => {
    expect(
      validateMonitorInput({ ...validHttpMonitor, port: 443 }).ok,
    ).toBe(false);
  });

  it("requires a valid port for TCPing monitors", () => {
    expect(
      validateMonitorInput({ ...validTcpMonitor, port: null }).ok,
    ).toBe(false);
  });

  it("rejects invalid monitor panel references and names", () => {
    expect(
      validateMonitorInput({ ...validHttpMonitor, panel_id: "" }).ok,
    ).toBe(false);
    expect(
      validateMonitorInput({ ...validHttpMonitor, name: "" }).ok,
    ).toBe(false);
  });
});
