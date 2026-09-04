import { describe, expect, it, vi } from "vitest";

import {
  runCheck,
  runHttpCheck,
  runTcpCheck,
} from "../src/checks";
import type { TcpSocketLike } from "../src/checks";
import type { MonitorRecord } from "../src/types";

const checkedAt = 1_735_689_600;

function httpConfig(target = "https://8.8.8.8/health") {
  return {
    monitor_id: "monitor-http",
    target,
    checked_at: checkedAt,
  };
}

function tcpConfig(target = "8.8.8.8") {
  return {
    monitor_id: "monitor-tcp",
    target,
    port: 443,
    checked_at: checkedAt,
  };
}

function fakeResponse(status: number) {
  const cancel = vi.fn(async () => undefined);
  const response = {
    status,
    body: { cancel },
  } as unknown as Response;
  return { response, cancel };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("HTTP checks", () => {
  it("maps a 200 response to ok and cancels its body", async () => {
    const { response, cancel } = fakeResponse(200);
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return response;
    });

    const result = await runHttpCheck(httpConfig(), { fetcher });

    expect(result).toMatchObject({
      monitor_id: "monitor-http",
      checked_at: checkedAt,
      status: "ok",
      http_status: 200,
      error_message: null,
    });
    expect(result.latency_ms).toEqual(expect.any(Number));
    expect(cancel).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      input: "https://8.8.8.8/health",
      init: {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
      },
    });
    expect(requests[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps a 503 response to http_error", async () => {
    const { response, cancel } = fakeResponse(503);
    const fetcher = vi.fn(async () => response);

    const result = await runHttpCheck(httpConfig(), { fetcher });

    expect(result).toMatchObject({
      status: "http_error",
      http_status: 503,
      error_message: expect.any(String),
    });
    expect(result.latency_ms).toEqual(expect.any(Number));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("maps a 302 response to ok", async () => {
    const { response } = fakeResponse(302);
    const fetcher = vi.fn(async () => response);

    const result = await runHttpCheck(httpConfig(), { fetcher });

    expect(result).toMatchObject({
      status: "ok",
      http_status: 302,
      error_message: null,
    });
    expect(result.latency_ms).toEqual(expect.any(Number));
  });

  it("maps a rejected fetch to a bounded error result", async () => {
    const message = "x".repeat(500);
    const fetcher = vi.fn(async () => {
      throw new Error(message);
    });

    const result = await runHttpCheck(httpConfig(), { fetcher });

    expect(result).toMatchObject({
      status: "error",
      latency_ms: null,
      http_status: null,
    });
    expect(result.error_message).toHaveLength(256);
  });

  it("maps a never-resolving fetch to timeout and aborts it", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetcher = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          signal = init?.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        },
      );

      const pending = runHttpCheck(httpConfig(), { fetcher });
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result).toMatchObject({
        status: "timeout",
        latency_ms: null,
        http_status: null,
        error_message: expect.any(String),
      });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fetch when probe-time destination validation rejects", async () => {
    const fetcher = vi.fn(async () => fakeResponse(200).response);
    const result = await runHttpCheck(
      httpConfig("https://monitor.example.com/health"),
      {
        fetcher,
        resolver: async () => ["10.0.0.1"],
      },
    );

    expect(result.status).toBe("error");
    expect(result.error_message).toMatch(/non-public/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("times out when destination validation never resolves", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => fakeResponse(200).response);
      const pending = runHttpCheck(
        httpConfig("https://monitor.example.com/health"),
        {
          fetcher,
          resolver: async () => new Promise<readonly string[]>(() => undefined),
        },
      );
      await vi.runAllTicks();

      const outcome = Promise.race([
        pending,
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 10_001);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(10_001);
      const result = await outcome;

      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        status: "timeout",
        latency_ms: null,
        http_status: null,
        error_message: expect.any(String),
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TCP checks", () => {
  it("pins a hostname connection to the first validated public address", async () => {
    const socket = {
      opened: Promise.resolve({}),
      close: vi.fn(async () => undefined),
    };
    const connector = vi.fn(() => socket);
    const resolver = vi.fn(async () => ["8.8.8.8", "1.1.1.1"]);

    const result = await runTcpCheck(tcpConfig("monitor.example.com"), {
      resolver,
      connector,
    });

    expect(result).toMatchObject({
      monitor_id: "monitor-tcp",
      checked_at: checkedAt,
      status: "ok",
      http_status: null,
      error_message: null,
    });
    expect(result.latency_ms).toEqual(expect.any(Number));
    expect(resolver).toHaveBeenCalledOnce();
    expect(connector).toHaveBeenCalledOnce();
    expect(connector).toHaveBeenCalledWith({ hostname: "8.8.8.8", port: 443 });
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("maps a rejected connector to error", async () => {
    const connector = vi.fn(async () => {
      throw new Error("connection refused");
    });

    const result = await runTcpCheck(tcpConfig(), { connector });

    expect(result).toMatchObject({
      status: "error",
      latency_ms: null,
      http_status: null,
      error_message: "connection refused",
    });
    expect(connector).toHaveBeenCalledOnce();
  });

  it("maps a never-resolving connector to timeout", async () => {
    vi.useFakeTimers();
    try {
      const connector = vi.fn(
        () => new Promise<TcpSocketLike>(() => undefined),
      );

      const pending = runTcpCheck(tcpConfig(), { connector });
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result).toMatchObject({
        status: "timeout",
        latency_ms: null,
        http_status: null,
        error_message: expect.any(String),
      });
      expect(connector).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records latency only after socket.opened resolves", async () => {
    const opened = deferred<unknown>();
    const socket = {
      opened: opened.promise,
      close: vi.fn(async () => undefined),
    };
    const connector = vi.fn(() => socket);
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(100).mockReturnValueOnce(175);

    try {
      const pending = runTcpCheck(tcpConfig(), { connector });
      await flushMicrotasks();
      expect(now).toHaveBeenCalledOnce();

      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      opened.resolve(undefined);
      const result = await pending;

      expect(result.status).toBe("ok");
      expect(result.latency_ms).toBe(75);
      expect(now).toHaveBeenCalledTimes(2);
      expect(socket.close).toHaveBeenCalledOnce();
    } finally {
      now.mockRestore();
    }
  });

  it("maps a never-opening socket to timeout and closes it", async () => {
    vi.useFakeTimers();
    try {
      const socket = {
        opened: new Promise<unknown>(() => undefined),
        close: vi.fn(async () => undefined),
      };
      const connector = vi.fn(() => socket);

      const pending = runTcpCheck(tcpConfig(), { connector });
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result).toMatchObject({
        status: "timeout",
        latency_ms: null,
        http_status: null,
        error_message: expect.any(String),
      });
      expect(socket.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not connect when probe-time destination validation rejects", async () => {
    const connector = vi.fn(() => ({
      opened: Promise.resolve({}),
      close: vi.fn(async () => undefined),
    }));

    const result = await runTcpCheck(
      tcpConfig("monitor.example.com"),
      {
        resolver: async () => ["192.168.1.10"],
        connector,
      },
    );

    expect(result.status).toBe("error");
    expect(result.error_message).toMatch(/non-public/i);
    expect(connector).not.toHaveBeenCalled();
  });

  it("times out when destination validation never resolves", async () => {
    vi.useFakeTimers();
    try {
      const connector = vi.fn(() => ({
        opened: Promise.resolve({}),
        close: vi.fn(async () => undefined),
      }));
      const pending = runTcpCheck(
        tcpConfig("monitor.example.com"),
        {
          connector,
          resolver: async () => new Promise<readonly string[]>(() => undefined),
        },
      );
      await vi.runAllTicks();

      const outcome = Promise.race([
        pending,
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 10_001);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(10_001);
      const result = await outcome;

      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        status: "timeout",
        latency_ms: null,
        http_status: null,
        error_message: expect.any(String),
      });
      expect(connector).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a socket returned by a connector after timeout", async () => {
    vi.useFakeTimers();
    try {
      let resolveConnector!: (socket: TcpSocketLike) => void;
      const connectorPromise = new Promise<TcpSocketLike>((resolve) => {
        resolveConnector = resolve;
      });
      const connector = vi.fn(() => connectorPromise);
      const pending = runTcpCheck(tcpConfig(), { connector });
      await flushMicrotasks();
      expect(connector).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toMatchObject({ status: "timeout" });

      const lateSocket = {
        opened: Promise.resolve({}),
        close: vi.fn(async () => undefined),
      };
      resolveConnector(lateSocket);
      await flushMicrotasks();

      expect(lateSocket.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("check dispatcher", () => {
  it("dispatches by kind and preserves the monitor id and checked_at", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_735_689_600_000));
    try {
      const { response } = fakeResponse(204);
      const fetcher = vi.fn(async () => response);
      const monitor: MonitorRecord = {
        id: "monitor-dispatch",
        panel_id: "panel-1",
        name: "Health",
        logo_url: null,
        kind: "http_get",
        target: "https://8.8.8.8/health",
        port: null,
        sort_order: 0,
        enabled: true,
        created_at: checkedAt,
        updated_at: checkedAt,
      };

      const result = await runCheck(monitor, { fetcher });

      expect(result.monitor_id).toBe("monitor-dispatch");
      expect(result.checked_at).toBe(checkedAt);
      expect(result.status).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches tcping through the validated connector", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_735_689_600_000));
    try {
      const socket = {
        opened: Promise.resolve({}),
        close: vi.fn(async () => undefined),
      };
      const connector = vi.fn(() => socket);
      const monitor: MonitorRecord = {
        id: "monitor-dispatch-tcp",
        panel_id: "panel-1",
        name: "DNS",
        logo_url: null,
        kind: "tcping",
        target: "monitor.example.com",
        port: 443,
        sort_order: 0,
        enabled: true,
        created_at: checkedAt,
        updated_at: checkedAt,
      };

      const result = await runCheck(monitor, {
        resolver: async () => ["1.1.1.1"],
        connector,
      });

      expect(result).toMatchObject({
        monitor_id: "monitor-dispatch-tcp",
        checked_at: checkedAt,
        status: "ok",
      });
      expect(connector).toHaveBeenCalledWith({ hostname: "1.1.1.1", port: 443 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("converts an unknown monitor kind to a safe error result", async () => {
    const monitor = {
      id: "monitor-unknown",
      panel_id: "panel-1",
      name: "Unknown",
      logo_url: null,
      kind: "other",
      target: "https://8.8.8.8/health",
      port: null,
      sort_order: 0,
      enabled: true,
      created_at: checkedAt,
      updated_at: checkedAt,
    } as unknown as MonitorRecord;

    const result = await runCheck(monitor, {
      fetcher: vi.fn(async () => fakeResponse(200).response),
    });

    expect(result).toMatchObject({
      monitor_id: "monitor-unknown",
      status: "error",
      latency_ms: null,
      http_status: null,
      error_message: "unsupported monitor kind",
    });
  });
});
