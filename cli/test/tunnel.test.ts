import { describe, it, expect, vi, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as WSClient } from "ws";
import { createServer, type Server } from "node:http";
import {
  encodeFrame,
  decodeFrameHeader,
  proxyToLocal,
  startTunnel,
  startTunnelWithReconnect,
  FRAME_REQUEST_HEADERS,
  FRAME_RESPONSE_HEADERS,
  FRAME_DATA,
  FRAME_END,
  type ResponseHeaders,
  type RequestHeaders,
} from "../src/tunnel.js";
import type { Config } from "../src/config.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createMockWs() {
  const sent: ArrayBuffer[] = [];
  return {
    send(data: ArrayBuffer) {
      sent.push(data);
    },
    sent,
  };
}

describe("encodeFrame", () => {
  it("creates correct binary format", () => {
    const payload = new TextEncoder().encode("hello");
    const frame = encodeFrame(1, FRAME_REQUEST_HEADERS, payload);

    expect(frame.byteLength).toBe(10);

    const view = new DataView(frame);
    expect(view.getUint32(0, false)).toBe(1);
    expect(view.getUint8(4)).toBe(FRAME_REQUEST_HEADERS);
    expect(new Uint8Array(frame, 5)).toEqual(payload);
  });

  it("handles no payload", () => {
    const frame = encodeFrame(42, FRAME_END);

    expect(frame.byteLength).toBe(5);

    const view = new DataView(frame);
    expect(view.getUint32(0, false)).toBe(42);
    expect(view.getUint8(4)).toBe(FRAME_END);
  });

  it("handles large streamId", () => {
    const frame = encodeFrame(0xffffffff, FRAME_DATA);
    const bytes = new Uint8Array(frame);

    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xff);
    expect(bytes[2]).toBe(0xff);
    expect(bytes[3]).toBe(0xff);
  });
});

describe("decodeFrameHeader", () => {
  it("parses correctly", () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, 7, false);
    view.setUint8(4, FRAME_DATA);
    new Uint8Array(buf, 5).set([1, 2, 3]);

    const frame = decodeFrameHeader(buf);
    expect(frame.streamId).toBe(7);
    expect(frame.type).toBe(FRAME_DATA);
    expect(frame.payload).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("handles empty payload", () => {
    const buf = new ArrayBuffer(5);
    const view = new DataView(buf);
    view.setUint32(0, 99, false);
    view.setUint8(4, FRAME_END);

    const frame = decodeFrameHeader(buf);
    expect(frame.streamId).toBe(99);
    expect(frame.type).toBe(FRAME_END);
    expect(frame.payload).toEqual(new Uint8Array([]));
  });

  it("roundtrips with encodeFrame", () => {
    const payload = new TextEncoder().encode("roundtrip payload");
    const encoded = encodeFrame(123, FRAME_RESPONSE_HEADERS, payload);
    const decoded = decodeFrameHeader(encoded);

    expect(decoded.streamId).toBe(123);
    expect(decoded.type).toBe(FRAME_RESPONSE_HEADERS);
    expect(decoded.payload).toEqual(payload);
  });
});

function decodeFrames(sent: ArrayBuffer[]) {
  return sent.map((buf) => decodeFrameHeader(buf));
}

describe("proxyToLocal", () => {
  it("proxies a GET request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("response body", {
          status: 200,
          headers: { "content-type": "text/plain" },
        })
      )
    );

    const ws = createMockWs();
    await proxyToLocal(
      ws as unknown as WebSocket,
      5,
      { method: "GET", path: "/foo", headers: {}, hasBody: false },
      "http://localhost:1234"
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:1234/foo",
      expect.objectContaining({ method: "GET" })
    );

    const frames = decodeFrames(ws.sent);
    expect(frames.map((f) => f.type)).toEqual([
      FRAME_RESPONSE_HEADERS,
      FRAME_DATA,
      FRAME_END,
    ]);
    expect(frames.every((f) => f.streamId === 5)).toBe(true);

    const respHeaders: ResponseHeaders = JSON.parse(
      new TextDecoder().decode(frames[0].payload)
    );
    expect(respHeaders.status).toBe(200);
    expect(respHeaders.headers["content-type"]).toBe("text/plain");

    expect(new TextDecoder().decode(frames[1].payload)).toBe("response body");
  });

  it("handles fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused"))
    );

    const ws = createMockWs();
    await proxyToLocal(
      ws as unknown as WebSocket,
      9,
      { method: "GET", path: "/foo", headers: {}, hasBody: false },
      "http://localhost:1234"
    );

    const frames = decodeFrames(ws.sent);
    expect(frames.map((f) => f.type)).toEqual([
      FRAME_RESPONSE_HEADERS,
      FRAME_DATA,
      FRAME_END,
    ]);

    const respHeaders: ResponseHeaders = JSON.parse(
      new TextDecoder().decode(frames[0].payload)
    );
    expect(respHeaders.status).toBe(502);

    const body = new TextDecoder().decode(frames[1].payload);
    expect(body).toContain("connection refused");
  });
});

function makeConfig(port: number): Config {
  return {
    gatewayUrl: `http://127.0.0.1:${port}`,
    oidcIssuer: "http://issuer.test",
    oidcClientID: "client",
    oidcTokenEndpoint: "http://issuer.test/token",
    oidcAuthorizationEndpoint: "http://issuer.test/authorize",
  };
}

async function withServer<T>(
  fn: (wss: WebSocketServer, port: number) => Promise<T>
): Promise<T> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return await fn(wss, port);
  } finally {
    wss.close();
    for (const client of wss.clients) client.terminate();
  }
}

describe("startTunnel", () => {
  it("connects and resolves with a handle", async () => {
    await withServer(async (wss, port) => {
      const handle = await startTunnel(
        makeConfig(port),
        "test-token",
        "sess1",
        "http://localhost:9999",
        "/tmp"
      );

      expect(handle).toHaveProperty("close");
      expect(typeof handle.close).toBe("function");

      handle.close();
    });
  });

  it("sends sessionId, directory, and auth header on connect", async () => {
    await withServer(async (wss, port) => {
      const requestInfo = new Promise<{ url: string; auth?: string }>(
        (resolve) => {
          wss.once("connection", (_ws, req) => {
            resolve({
              url: req.url ?? "",
              auth: req.headers["authorization"],
            });
          });
        }
      );

      const handle = await startTunnel(
        makeConfig(port),
        "test-token",
        "sess1",
        "http://localhost:9999",
        "/my/project"
      );

      const { url, auth } = await requestInfo;
      expect(url).toContain("sessionId=sess1");
      expect(url).toContain("directory=%2Fmy%2Fproject");
      expect(auth).toBe("Bearer test-token");

      handle.close();
    });
  });

  it("proxies incoming request frames back through the tunnel", async () => {
    const localServer: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
    });
    await new Promise<void>((resolve) => localServer.listen(0, resolve));
    const localAddress = localServer.address();
    const localPort =
      typeof localAddress === "object" && localAddress ? localAddress.port : 0;

    try {
      await withServer(async (wss, port) => {
        const serverConn = new Promise<WSClient>((resolve) => {
          wss.once("connection", (ws) => resolve(ws));
        });

        const handle = await startTunnel(
          makeConfig(port),
          "test-token",
          "sess1",
          `http://127.0.0.1:${localPort}`,
          "/tmp"
        );

        const serverWs = await serverConn;

        const framesReceived: Promise<
          { streamId: number; type: number; payload: Uint8Array }[]
        > = new Promise((resolve) => {
          const frames: { streamId: number; type: number; payload: Uint8Array }[] =
            [];
          serverWs.on("message", (data: Buffer) => {
            const arrayBuffer = data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength
            );
            const frame = decodeFrameHeader(arrayBuffer as ArrayBuffer);
            frames.push(frame);
            if (frame.type === FRAME_END) resolve(frames);
          });
        });

        const reqHeaders: RequestHeaders = {
          method: "GET",
          path: "/foo",
          headers: {},
          hasBody: false,
        };
        const payload = new TextEncoder().encode(JSON.stringify(reqHeaders));
        serverWs.send(encodeFrame(1, FRAME_REQUEST_HEADERS, payload));

        const frames = await framesReceived;
        expect(frames.map((f) => f.type)).toEqual([
          FRAME_RESPONSE_HEADERS,
          FRAME_DATA,
          FRAME_END,
        ]);
        expect(frames.every((f) => f.streamId === 1)).toBe(true);

        const respHeaders: ResponseHeaders = JSON.parse(
          new TextDecoder().decode(frames[0].payload)
        );
        expect(respHeaders.status).toBe(200);
        expect(new TextDecoder().decode(frames[1].payload)).toBe("hello");

        handle.close();
      });
    } finally {
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });

  it("rejects when the connection fails", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const address = wss.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    await expect(
      startTunnel(
        makeConfig(port),
        "test-token",
        "sess1",
        "http://localhost:9999",
        "/tmp"
      )
    ).rejects.toThrow();
  });
});

async function withHttpServer<T>(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  fn: (port: number) => Promise<T>
): Promise<T> {
  const srv = createServer(handler);
  await new Promise<void>((resolve) => srv.listen(0, resolve));
  const address = srv.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

describe("startTunnel pre-flight", () => {
  it("rejects with 401 status and error body", async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("invalid token: token is expired");
      },
      async (port) => {
        await expect(
          startTunnel(makeConfig(port), "bad-token", "s1", "http://localhost:9999", "/tmp")
        ).rejects.toThrow("Tunnel pre-flight failed: 401");

        await expect(
          startTunnel(makeConfig(port), "bad-token", "s1", "http://localhost:9999", "/tmp")
        ).rejects.toThrow("invalid token: token is expired");
      }
    );
  });

  it("rejects with 403 status", async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("forbidden");
      },
      async (port) => {
        await expect(
          startTunnel(makeConfig(port), "token", "s1", "http://localhost:9999", "/tmp")
        ).rejects.toThrow("Tunnel pre-flight failed: 403");
      }
    );
  });

  it("rejects with 502 status", async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("bad gateway");
      },
      async (port) => {
        await expect(
          startTunnel(makeConfig(port), "token", "s1", "http://localhost:9999", "/tmp")
        ).rejects.toThrow("Tunnel pre-flight failed: 502");
      }
    );
  });

  it("passes through on 400 (expected from tunneler)", async () => {
    // The actual tunneler returns 400 for non-websocket requests.
    // Pre-flight should not reject on 400 — it proceeds to WebSocket.
    // We can't test the full WS path here, so just verify no throw from pre-flight
    // by checking it eventually fails on the WS upgrade (not the pre-flight).
    await withHttpServer(
      (_req, res) => {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Not a websocket request");
      },
      async (port) => {
        // Will fail on WebSocket upgrade (not pre-flight)
        await expect(
          startTunnel(makeConfig(port), "token", "s1", "http://localhost:9999", "/tmp")
        ).rejects.toThrow();

        // But NOT a pre-flight error
        const err = await startTunnel(
          makeConfig(port), "token", "s1", "http://localhost:9999", "/tmp"
        ).catch((e: Error) => e);
        expect(err.message).not.toContain("pre-flight");
      }
    );
  });

  it("passes through on 426 (Upgrade Required)", async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(426, { "Content-Type": "text/plain" });
        res.end("Upgrade Required");
      },
      async (port) => {
        const err = await startTunnel(
          makeConfig(port), "token", "s1", "http://localhost:9999", "/tmp"
        ).catch((e: Error) => e);
        expect(err.message).not.toContain("pre-flight");
      }
    );
  });

  it("rejects with network error when server unreachable", async () => {
    // Use a port with no server
    await expect(
      startTunnel(makeConfig(1), "token", "s1", "http://localhost:9999", "/tmp")
    ).rejects.toThrow();
  });
});

describe("startTunnelWithReconnect", () => {
  it("connects successfully and close() stops it", async () => {
    await withServer(async (wss, port) => {
      const handle = await startTunnelWithReconnect(
        makeConfig(port),
        "test-token",
        "sess1",
        "http://localhost:9999",
        "/tmp"
      );

      expect(typeof handle.close).toBe("function");
      handle.close();
    });
  });
});
