import { describe, expect, it } from "vitest";

import {
  isPublicDestination,
  validatePublicDestination,
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
    ["192.0.0.1", "IPv4 protocol assignment"],
    ["192.0.2.1", "IPv4 documentation"],
    ["192.0.0.9", "IPv4 protocol assignment"],
    ["192.31.196.1", "IPv4 AS112"],
    ["192.52.193.1", "IPv4 AMT"],
    ["192.88.99.2", "deprecated IPv4 6to4 relay"],
    ["192.175.48.1", "IPv4 AS112 delegation"],
    ["192.88.99.1", "deprecated IPv4 6to4 relay"],
    ["198.51.100.1", "IPv4 documentation"],
    ["203.0.113.1", "IPv4 documentation"],
    ["198.19.255.254", "IPv4 benchmarking"],
    ["100.64.0.1", "IPv4 shared address space"],
    ["240.0.0.1", "IPv4 reserved"],
    ["255.255.255.255", "IPv4 limited broadcast"],
    ["168.63.129.16", "Azure platform virtual IP"],
    ["::192.0.2.1", "deprecated IPv4-compatible IPv6"],
    ["2001:db8::1", "IPv6 documentation"],
    ["2001::1", "IPv6 protocol assignment"],
    ["2001:1ff::1", "IPv6 protocol assignment boundary"],
    ["2001:2::1", "IPv6 benchmarking"],
    ["3fff::1", "IPv6 documentation"],
    ["::8.8.8.8", "IPv4-compatible IPv6"],
    ["::ffff:192.168.1.1", "mapped RFC1918"],
    ["::ffff:8.8.8.8", "IPv4-mapped public address"],
    ["64:ff9b::8.8.8.8", "IPv4 translation prefix"],
    ["64:ff9b:1::1", "IPv4 translation local-use prefix"],
    ["100::1", "IPv6 discard-only"],
    ["100:0:0:1::1", "IPv6 dummy prefix"],
    ["2001:3::1", "IPv6 AMT"],
    ["2001:4:112::1", "IPv6 AS112"],
    ["2001:10::1", "deprecated IPv6 ORCHID"],
    ["2001:20::1", "IPv6 ORCHIDv2"],
    ["2001:30::1", "IPv6 Drone Remote ID"],
    ["2002::1", "IPv6 6to4"],
    ["2620:4f:8000::1", "IPv6 AS112 delegation"],
    ["5f00::1", "IPv6 SRv6 SID"],
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

describe("DNS revalidation before probing", () => {
  it("accepts a hostname when every injected A/AAAA answer is public", async () => {
    const result = await validatePublicDestination("monitor.example.com", {
      resolver: async (hostname) => {
        expect(hostname).toBe("monitor.example.com");
        return ["8.8.8.8", "2001:4860:4860::8888"];
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        host: "monitor.example.com",
        addresses: ["8.8.8.8", "2001:4860:4860::8888"],
      },
    });
  });

  it("rejects a hostname when injected DNS returns a private answer", async () => {
    const result = await validatePublicDestination("monitor.example.com", {
      resolver: async () => ["10.0.0.1"],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a hostname when injected DNS mixes public and private answers", async () => {
    const result = await validatePublicDestination("monitor.example.com", {
      resolver: async () => ["8.8.8.8", "192.168.1.10"],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a hostname when injected DNS has no answers", async () => {
    const result = await validatePublicDestination("monitor.example.com", {
      resolver: async () => [],
    });

    expect(result.ok).toBe(false);
  });

  it("keeps synchronous literal checks and does not resolve an IP literal", async () => {
    let resolverCalls = 0;
    const result = await validatePublicDestination("8.8.8.8", {
      resolver: async () => {
        resolverCalls += 1;
        return ["10.0.0.1"];
      },
    });

    expect(result).toEqual({
      ok: true,
      value: { host: "8.8.8.8", addresses: ["8.8.8.8"] },
    });
    expect(resolverCalls).toBe(0);
  });

  it("uses Cloudflare DNS-over-HTTPS A and AAAA queries by default", async () => {
    const requests: Array<{ url: URL; headers: Headers }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input.toString());
      requests.push({ url, headers: new Headers(init?.headers) });
      const answer = url.searchParams.get("type") === "A"
        ? { type: 1, data: "8.8.8.8" }
        : { type: 28, data: "2001:4860:4860::8888" };
      return new Response(JSON.stringify({ Status: 0, Answer: [answer] }), {
        status: 200,
        headers: { "content-type": "application/dns-json" },
      });
    };

    const result = await validatePublicDestination("monitor.example.com", {
      fetcher,
    });

    expect(result.ok).toBe(true);
    expect(requests.map(({ url }) => [url.hostname, url.searchParams.get("type")])).toEqual([
      ["cloudflare-dns.com", "A"],
      ["cloudflare-dns.com", "AAAA"],
    ]);
    expect(requests.every(({ headers }) => headers.get("accept") === "application/dns-json")).toBe(true);
  });

  it("rejects a non-public answer returned by Cloudflare DNS-over-HTTPS", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(input.toString());
      const answer = url.searchParams.get("type") === "A"
        ? { type: 1, data: "10.0.0.1" }
        : { type: 28, data: "2001:4860:4860::8888" };
      return new Response(JSON.stringify({ Status: 0, Answer: [answer] }), {
        status: 200,
      });
    };

    const result = await validatePublicDestination("monitor.example.com", {
      fetcher,
    });

    expect(result.ok).toBe(false);
  });

  it("rejects empty A and AAAA answers returned by Cloudflare DNS-over-HTTPS", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 });

    const result = await validatePublicDestination("monitor.example.com", {
      fetcher,
    });

    expect(result.ok).toBe(false);
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
