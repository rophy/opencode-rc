import { describe, it, expect, vi, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as WSClient } from "ws";
import { createServer, type Server } from "node:http";
import {
  encodeFrame,
  decodeFrameHeader,
  proxyToLocal,
  handleBodyFrame,
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
import { ProtocolError } from "../src/protocol.js";

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

// Minimal raw WebSocket wire-frame helpers for testing the byte-for-byte
// socket relay: client->server frames are masked per RFC 6455, server->client
// frames aren't. Only small (<126 byte) single-frame text messages are needed here.
function encodeClientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

function decodeServerTextFrame(buf: Buffer): string {
  const len = buf[1] & 0x7f;
  return buf.subarray(2, 2 + len).toString("utf8");
}

function encodeServerTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
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

describe("proxyToLocal with a WebSocket upgrade", () => {
  it("dials the local server, replies 101, and relays data both ways", async () => {
    const localWss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => localWss.once("listening", resolve));
    const localAddress = localWss.address();
    const localPort = typeof localAddress === "object" && localAddress ? localAddress.port : 0;

    const localServerConn = new Promise<WSClient>((resolve) => {
      localWss.once("connection", (socket) => resolve(socket));
    });

    try {
      const ws = createMockWs();
      proxyToLocal(
        ws as unknown as WebSocket,
        7,
        {
          method: "GET",
          path: "/pty/abc/connect?cursor=0",
          headers: {
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
          hasBody: false,
        },
        `http://127.0.0.1:${localPort}`
      );

      const localSocket = await localServerConn;
      localSocket.on("message", (data: Buffer) => {
        localSocket.send(`echo:${data.toString()}`);
      });

      // Wait for the 101 response frame before sending browser->local data.
      await vi.waitFor(() => {
        expect(decodeFrames(ws.sent).some((f) => f.type === FRAME_RESPONSE_HEADERS)).toBe(true);
      });

      const respHeaders: ResponseHeaders = JSON.parse(
        new TextDecoder().decode(decodeFrames(ws.sent)[0].payload)
      );
      expect(respHeaders.status).toBe(101);
      // RFC 6455 test vector: Sec-WebSocket-Key "dGhlIHNhbXBsZSBub25jZQ=="
      // must accept as "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" — computed by the real
      // local server, proving the key was forwarded to it, not synthesized here.
      expect(respHeaders.headers["Sec-WebSocket-Accept"]).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");

      // Simulate the gateway forwarding an already-framed browser message as
      // FRAME_DATA — this must reach the local server as valid wire bytes,
      // not get re-framed by a higher-level WebSocket client.
      handleBodyFrame(ws as unknown as WebSocket, 7, FRAME_DATA, encodeClientTextFrame("hello"));

      await vi.waitFor(() => {
        const dataFrames = decodeFrames(ws.sent).filter((f) => f.type === FRAME_DATA);
        expect(dataFrames.length).toBeGreaterThan(0);
      });
      const dataFrame = decodeFrames(ws.sent).find((f) => f.type === FRAME_DATA)!;
      expect(decodeServerTextFrame(Buffer.from(dataFrame.payload))).toBe("echo:hello");

      // Browser closing the stream closes the local socket too.
      handleBodyFrame(ws as unknown as WebSocket, 7, FRAME_END, new Uint8Array());
      await vi.waitFor(() => {
        expect(decodeFrames(ws.sent).some((f) => f.type === FRAME_END)).toBe(true);
      });
    } finally {
      localWss.close();
      for (const client of localWss.clients) client.terminate();
    }
  });

  it("sends a 502 when the local server rejects the upgrade", async () => {
    const ws = createMockWs();
    proxyToLocal(
      ws as unknown as WebSocket,
      11,
      {
        method: "GET",
        path: "/pty/x/connect",
        headers: { upgrade: "websocket" },
        hasBody: false,
      },
      "http://127.0.0.1:1" // nothing listens here
    );

    await vi.waitFor(() => {
      expect(decodeFrames(ws.sent).some((f) => f.type === FRAME_RESPONSE_HEADERS)).toBe(true);
    });

    const frames = decodeFrames(ws.sent);
    const respHeaders: ResponseHeaders = JSON.parse(new TextDecoder().decode(frames[0].payload));
    expect(respHeaders.status).toBe(502);
    expect(frames.map((f) => f.type)).toEqual([FRAME_RESPONSE_HEADERS, FRAME_DATA, FRAME_END]);
  });

  it("relays bytes the local server already sent past the upgrade response (head)", async () => {
    // A raw server, not the `ws` library, so we control exactly what goes out
    // on the wire: the 101 response and a full WS frame written back-to-back,
    // synchronously, so Node's http client is very likely to hand them to us
    // together as (response headers, `head` = the frame bytes) rather than as
    // two separate reads — reproducing what opencode's pty connect handler
    // does when it writes its cursor/replay frame right after upgrading.
    const localServer = createServer();
    let serverSideSocket: import("node:net").Socket | undefined;
    localServer.on("upgrade", (_req, socket) => {
      serverSideSocket = socket;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "\r\n"
      );
      socket.write(encodeServerTextFrame("hello"));
    });
    await new Promise<void>((resolve) => localServer.listen(0, resolve));
    const localAddress = localServer.address();
    const localPort = typeof localAddress === "object" && localAddress ? localAddress.port : 0;

    try {
      const ws = createMockWs();
      proxyToLocal(
        ws as unknown as WebSocket,
        13,
        {
          method: "GET",
          path: "/pty/abc/connect",
          headers: {
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
          hasBody: false,
        },
        `http://127.0.0.1:${localPort}`
      );

      await vi.waitFor(() => {
        expect(decodeFrames(ws.sent).some((f) => f.type === FRAME_DATA)).toBe(true);
      });

      const frames = decodeFrames(ws.sent);
      expect(frames[0].type).toBe(FRAME_RESPONSE_HEADERS);
      const dataFrame = frames.find((f) => f.type === FRAME_DATA)!;
      expect(decodeServerTextFrame(Buffer.from(dataFrame.payload))).toBe("hello");
    } finally {
      // The raw hijacked connection is never ended, so plain close() would
      // wait forever for it; destroy it directly instead of awaiting close().
      serverSideSocket?.destroy();
      localServer.close();
    }
  });
});

describe("WebSocket streams are scoped per tunnel connection", () => {
  it("destroys local sockets when the tunnel closes, and a reused stream id on a new tunnel isn't shadowed", async () => {
    const localWss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => localWss.once("listening", resolve));
    const localAddress = localWss.address();
    const localPort = typeof localAddress === "object" && localAddress ? localAddress.port : 0;

    const localSocketClosed = new Promise<void>((resolve) => {
      localWss.once("connection", (socket) => socket.once("close", () => resolve()));
    });

    try {
      await withServer(async (wss, port) => {
        const serverConn = new Promise<WSClient>((resolve) => wss.once("connection", (s) => resolve(s)));
        const handle = await startTunnel(
          makeConfig(port),
          "test-token",
          "sess-ws",
          `http://127.0.0.1:${localPort}`,
          "/tmp"
        );
        const serverWs = await serverConn;

        const upgradeReceived = new Promise<void>((resolve) => {
          serverWs.on("message", function onMsg(data: Buffer) {
            const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
            const frame = decodeFrameHeader(buf);
            if (frame.type === FRAME_RESPONSE_HEADERS) {
              serverWs.off("message", onMsg);
              resolve();
            }
          });
        });

        const wsReq: RequestHeaders = {
          method: "GET",
          path: "/pty/abc/connect",
          headers: {
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
          hasBody: false,
        };
        serverWs.send(encodeFrame(1, FRAME_REQUEST_HEADERS, new TextEncoder().encode(JSON.stringify(wsReq))));
        await upgradeReceived;

        // Closing the tunnel must tear down the local WebSocket it opened —
        // observed here as the local server's end of that connection closing.
        handle.close();
      });
      await localSocketClosed;
    } finally {
      localWss.close();
      for (const client of localWss.clients) client.terminate();
    }

    // A brand-new tunnel that happens to reuse stream id 1 (gateway's mux
    // restarts stream ids per tunnel) for an ordinary POST-with-body request
    // must not be shadowed by the previous tunnel's now-dead WebSocket stream
    // (handleBodyFrame checks the WebSocket-stream map before pendingRequests).
    const echoServer: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`echo: ${body}`);
      });
    });
    await new Promise<void>((resolve) => echoServer.listen(0, resolve));
    const echoAddress = echoServer.address();
    const echoPort = typeof echoAddress === "object" && echoAddress ? echoAddress.port : 0;

    try {
      await withServer(async (wss2, port2) => {
        const serverConn2 = new Promise<WSClient>((resolve) => wss2.once("connection", (s) => resolve(s)));
        const handle2 = await startTunnel(
          makeConfig(port2),
          "test-token",
          "sess-http",
          `http://127.0.0.1:${echoPort}`,
          "/tmp"
        );
        const serverWs2 = await serverConn2;

        const framesReceived = new Promise<{ type: number; payload: Uint8Array }[]>((resolve) => {
          const frames: { type: number; payload: Uint8Array }[] = [];
          serverWs2.on("message", (data: Buffer) => {
            const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
            const frame = decodeFrameHeader(buf);
            frames.push(frame);
            if (frame.type === FRAME_END) resolve(frames);
          });
        });

        const postReq: RequestHeaders = {
          method: "POST",
          path: "/submit",
          headers: { "content-type": "text/plain" },
          hasBody: true,
        };
        serverWs2.send(encodeFrame(1, FRAME_REQUEST_HEADERS, new TextEncoder().encode(JSON.stringify(postReq))));
        serverWs2.send(encodeFrame(1, FRAME_DATA, new TextEncoder().encode("still works")));
        serverWs2.send(encodeFrame(1, FRAME_END));

        const frames = await framesReceived;
        expect(frames.map((f) => f.type)).toEqual([FRAME_RESPONSE_HEADERS, FRAME_DATA, FRAME_END]);
        const respHeaders: ResponseHeaders = JSON.parse(new TextDecoder().decode(frames[0].payload));
        expect(respHeaders.status).toBe(200);
        expect(new TextDecoder().decode(frames[1].payload)).toBe("echo: still works");

        handle2.close();
      });
    } finally {
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    }
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

// A plain HTTP request (the CLI's pre-flight) hitting a bare `ws`
// WebSocketServer gets that library's own hard-coded 426 response, which
// carries no OpenCode-RC-Protocol header. Front it with our own HTTP server
// so the pre-flight sees a protocol header, same as the real gateway.
function protocolAwareWss(): { wss: WebSocketServer; httpServer: Server } {
  const httpServer = createServer((_req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain", "OpenCode-RC-Protocol": "1" });
    res.end("Upgrade Required");
  });
  const wss = new WebSocketServer({ server: httpServer });
  return { wss, httpServer };
}

async function withServer<T>(
  fn: (wss: WebSocketServer, port: number) => Promise<T>
): Promise<T> {
  const { wss, httpServer } = protocolAwareWss();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return await fn(wss, port);
  } finally {
    wss.close();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
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
        res.writeHead(401, { "Content-Type": "text/plain", "OpenCode-RC-Protocol": "1" });
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
        res.writeHead(403, { "Content-Type": "text/plain", "OpenCode-RC-Protocol": "1" });
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

  it("passes through on 400 (expected from gateway)", async () => {
    // The actual gateway returns 400 for non-websocket requests.
    // Pre-flight should not reject on 400 — it proceeds to WebSocket.
    // We can't test the full WS path here, so just verify no throw from pre-flight
    // by checking it eventually fails on the WS upgrade (not the pre-flight).
    await withHttpServer(
      (_req, res) => {
        res.writeHead(400, { "Content-Type": "text/plain", "OpenCode-RC-Protocol": "1" });
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
        res.writeHead(426, { "Content-Type": "text/plain", "OpenCode-RC-Protocol": "1" });
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

describe("protocol versioning", () => {
  it("sends the protocol header on the pre-flight", async () => {
    let seen: string | undefined;
    await withHttpServer(
      (req, res) => {
        seen = req.headers["opencode-rc-protocol"] as string | undefined;
        res.writeHead(401, { "Content-Type": "text/plain", "OpenCode-RC-Protocol": "1" });
        res.end("no");
      },
      async (port) => {
        await expect(startTunnel(makeConfig(port), "t", "s1", "http://localhost:9999", "/tmp")).rejects.toThrow();
      }
    );
    expect(seen).toBe("1");
  });

  it("stops with an update message when the gateway says the CLI is outdated", async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(426, { "Content-Type": "application/json", "OpenCode-RC-Protocol": "2" });
        res.end(JSON.stringify({ error: "client_outdated", client: 1, minimum: 2, server: 2 }));
      },
      async (port) => {
        const p = startTunnel(makeConfig(port), "t", "s1", "http://localhost:9999", "/tmp");
        await expect(p).rejects.toBeInstanceOf(ProtocolError);
        await expect(p).rejects.toThrow("opencode-rc CLI is too old for this server. Update it: npm i -g opencode-rc@latest");
      }
    );
  });

  it("stops when the gateway is older than the CLI supports", async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(400, { "Content-Type": "text/plain" }); // an old gateway: no protocol header
        res.end("websocket required");
      },
      async (port) => {
        const p = startTunnel(makeConfig(port), "t", "s1", "http://localhost:9999", "/tmp");
        await expect(p).rejects.toBeInstanceOf(ProtocolError);
        await expect(p).rejects.toThrow(
          `The gateway at ${makeConfig(port).gatewayUrl} is older than this CLI supports. Ask your administrator to upgrade it.`
        );
      }
    );
  });

  it("does not retry protocol errors", async () => {
    let calls = 0;
    await withHttpServer(
      (_req, res) => {
        calls++;
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("old gateway");
      },
      async (port) => {
        await expect(
          startTunnelWithReconnect(makeConfig(port), "t", "s1", "http://localhost:9999", "/tmp")
        ).rejects.toBeInstanceOf(ProtocolError);
      }
    );
    expect(calls).toBe(1);
  });

  it("does not treat a header-less 502 as a protocol error (falls through to the ordinary retryable error path)", async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("bad gateway");
      },
      async (port) => {
        const err = await startTunnel(makeConfig(port), "t", "s1", "http://localhost:9999", "/tmp").catch((e) => e);
        expect(err).not.toBeInstanceOf(ProtocolError);
        expect(err.message).toContain("Tunnel pre-flight failed: 502");
      }
    );
  });

  it("retries a header-less 502 on the pre-flight via startTunnelWithReconnect's initial loop", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const httpServer = createServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(502, { "Content-Type": "text/plain" }); // header-less, proxy-style
        res.end("bad gateway");
        return;
      }
      // Subsequent pre-flight GETs: a normal, header-carrying response that
      // passes both checks and falls through to the WS upgrade below (which
      // this same httpServer's attached WebSocketServer handles).
      res.writeHead(400, { "Content-Type": "text/plain", "OpenCode-RC-Protocol": "1" });
      res.end("websocket required");
    });
    const wss = new WebSocketServer({ server: httpServer });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const handle = await startTunnelWithReconnect(makeConfig(port), "t", "s1", "http://localhost:9999", "/tmp");
      // Not a ProtocolError (would have rejected), and the server saw more
      // than one attempt — the header-less 502 was retried rather than fatal.
      expect(calls).toBeGreaterThan(1);
      handle.close();
    } finally {
      wss.close();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }, 10000);
});

describe("handleBodyFrame and proxyToLocal with body", () => {
  it("accumulates body chunks and proxies POST request", async () => {
    const localServer: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`echo: ${body}`);
      });
    });
    await new Promise<void>((resolve) => localServer.listen(0, resolve));
    const localAddress = localServer.address();
    const localPort = typeof localAddress === "object" && localAddress ? localAddress.port : 0;

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

        const framesReceived = new Promise<{ streamId: number; type: number; payload: Uint8Array }[]>(
          (resolve) => {
            const frames: { streamId: number; type: number; payload: Uint8Array }[] = [];
            serverWs.on("message", (data: Buffer) => {
              const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
              const frame = decodeFrameHeader(arrayBuffer as ArrayBuffer);
              frames.push(frame);
              if (frame.type === FRAME_END) resolve(frames);
            });
          }
        );

        // Send request headers with hasBody: true
        const reqHeaders: RequestHeaders = {
          method: "POST",
          path: "/submit",
          headers: { "content-type": "text/plain" },
          hasBody: true,
        };
        const headerPayload = new TextEncoder().encode(JSON.stringify(reqHeaders));
        serverWs.send(encodeFrame(10, FRAME_REQUEST_HEADERS, headerPayload));

        // Send body in two chunks
        serverWs.send(encodeFrame(10, FRAME_DATA, new TextEncoder().encode("hello ")));
        serverWs.send(encodeFrame(10, FRAME_DATA, new TextEncoder().encode("world")));
        serverWs.send(encodeFrame(10, FRAME_END));

        const frames = await framesReceived;
        expect(frames.map((f) => f.type)).toEqual([
          FRAME_RESPONSE_HEADERS,
          FRAME_DATA,
          FRAME_END,
        ]);

        const respHeaders: ResponseHeaders = JSON.parse(
          new TextDecoder().decode(frames[0].payload)
        );
        expect(respHeaders.status).toBe(200);
        expect(new TextDecoder().decode(frames[1].payload)).toBe("echo: hello world");

        handle.close();
      });
    } finally {
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });

  it("ignores handleBodyFrame for unknown streamId", async () => {
    const { handleBodyFrame } = await import("../src/tunnel.js");
    handleBodyFrame({} as unknown as WebSocket, 99999, FRAME_DATA, new Uint8Array([1, 2, 3]));
  });
});

describe("startTunnel message handling", () => {
  it("ignores frames shorter than 5 bytes", async () => {
    await withServer(async (wss, port) => {
      const serverConn = new Promise<WSClient>((resolve) => {
        wss.once("connection", (ws) => resolve(ws));
      });

      const handle = await startTunnel(
        makeConfig(port),
        "test-token",
        "sess1",
        "http://localhost:9999",
        "/tmp"
      );

      const serverWs = await serverConn;

      // Send a too-short frame — should be silently ignored
      serverWs.send(Buffer.from([0x00, 0x01]));

      // Give it a moment to process
      await new Promise((r) => setTimeout(r, 50));

      handle.close();
    });
  });
});

describe("startTunnel post-connection events", () => {
  it("logs error after connection is established", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await withServer(async (wss, port) => {
      const serverConn = new Promise<WSClient>((resolve) => {
        wss.once("connection", (ws) => resolve(ws));
      });

      const handle = await startTunnel(
        makeConfig(port),
        "test-token",
        "sess1",
        "http://localhost:9999",
        "/tmp"
      );

      const serverWs = await serverConn;

      // Force an error after connected by terminating the server-side abruptly
      serverWs.terminate();

      // Wait for the disconnected promise
      await handle.disconnected;

      handle.close();
    });
    errorSpy.mockRestore();
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

  it("retries on initial connection failure then connects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Allocate a port, then close so first attempt fails
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const address = wss.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    // Start connecting — first attempt will fail, then retry
    let wss2: WebSocketServer | null = null;
    let httpServer2: Server | null = null;
    const connectPromise = startTunnelWithReconnect(
      makeConfig(port),
      "test-token",
      "sess1",
      "http://localhost:9999",
      "/tmp"
    );

    // After a short delay (let first attempt fail), start the server
    await new Promise((r) => setTimeout(r, 500));
    ({ wss: wss2, httpServer: httpServer2 } = protocolAwareWss());
    await new Promise<void>((resolve) => httpServer2!.listen(port, resolve));

    try {
      const handle = await connectPromise;

      expect(typeof handle.close).toBe("function");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Tunnel error:"));

      handle.close();
    } finally {
      wss2?.close();
      if (wss2) for (const client of wss2.clients) client.terminate();
      if (httpServer2) await new Promise<void>((resolve) => httpServer2!.close(() => resolve()));
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  }, 10000);

  it("reconnects after tunnel disconnects", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await withServer(async (wss, port) => {
      let connectionCount = 0;
      wss.on("connection", () => { connectionCount++; });

      const handle = await startTunnelWithReconnect(
        makeConfig(port),
        "test-token",
        "sess1",
        "http://localhost:9999",
        "/tmp"
      );

      expect(connectionCount).toBe(1);

      // Terminate all server-side connections to trigger reconnect
      for (const client of wss.clients) client.terminate();

      // Wait for reconnection
      await new Promise((r) => setTimeout(r, 2000));

      expect(connectionCount).toBeGreaterThanOrEqual(2);
      expect(logSpy).toHaveBeenCalledWith("Tunnel disconnected, will reconnect...");

      handle.close();
    });

    logSpy.mockRestore();
  }, 10000);

  it("background reconnect loop retries a header-less 5xx pre-flight instead of treating it as fatal", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await withServer(async (wss, port) => {
      let reconnectAttempts = 0;
      let failOnce = false;

      const handle = await startTunnelWithReconnect(
        makeConfig(port),
        "test-token",
        "sess1",
        "http://localhost:9999",
        "/tmp"
      );

      // Swap the server's HTTP handling: after the tunnel drops, the next
      // pre-flight the reconnect loop makes gets a header-less 502 first,
      // then succeeds through to the normal (header-carrying) 426 path.
      const httpServer = (wss as any)._server;
      httpServer.removeAllListeners("request");
      httpServer.on("request", (_req: any, res: any) => {
        reconnectAttempts++;
        if (!failOnce) {
          failOnce = true;
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("bad gateway");
          return;
        }
        res.writeHead(426, { "Content-Type": "text/plain", "OpenCode-RC-Protocol": "1" });
        res.end("Upgrade Required");
      });

      for (const client of wss.clients) client.terminate();

      await new Promise((r) => setTimeout(r, 2000));

      expect(reconnectAttempts).toBeGreaterThan(1);

      handle.close();
    });

    logSpy.mockRestore();
    errorSpy.mockRestore();
  }, 10000);

  it("calls onFatal with a ProtocolError when the reconnect loop's pre-flight hits a header-less non-5xx response, instead of exiting the process", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await withServer(async (wss, port) => {
      const onFatal = vi.fn();
      const handle = await startTunnelWithReconnect(
        makeConfig(port),
        "test-token",
        "sess1",
        "http://localhost:9999",
        "/tmp",
        onFatal
      );

      const httpServer = (wss as any)._server;
      httpServer.removeAllListeners("request");
      httpServer.on("request", (_req: any, res: any) => {
        // Header-less, non-5xx: an old gateway that doesn't speak protocol
        // versioning at all — this is the fatal, non-retryable case.
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("old gateway");
      });

      for (const client of wss.clients) client.terminate();

      await vi.waitFor(() => {
        expect(onFatal).toHaveBeenCalledWith(expect.any(ProtocolError));
      });

      expect(exitSpy).not.toHaveBeenCalled();

      handle.close();
    });

    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }, 10000);
});
