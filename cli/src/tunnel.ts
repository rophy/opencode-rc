import type { Config } from "./config.js";
import WebSocket from "ws";
import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";

export const FRAME_REQUEST_HEADERS = 0x01;
export const FRAME_RESPONSE_HEADERS = 0x02;
export const FRAME_DATA = 0x03;
export const FRAME_END = 0x04;

export interface RequestHeaders {
  method: string;
  path: string;
  headers: Record<string, string>;
  hasBody: boolean;
}

export interface ResponseHeaders {
  status: number;
  headers: Record<string, string>;
}

export function encodeFrame(
  streamId: number,
  type: number,
  payload?: Uint8Array
): ArrayBuffer {
  const header = new ArrayBuffer(5 + (payload?.length ?? 0));
  const view = new DataView(header);
  view.setUint32(0, streamId, false); // big-endian
  view.setUint8(4, type);
  if (payload && payload.length > 0) {
    new Uint8Array(header, 5).set(payload);
  }
  return header;
}

export function decodeFrameHeader(data: ArrayBuffer): {
  streamId: number;
  type: number;
  payload: Uint8Array;
} {
  const view = new DataView(data);
  return {
    streamId: view.getUint32(0, false),
    type: view.getUint8(4),
    payload: new Uint8Array(data, 5),
  };
}

// Pending requests waiting for body data
const pendingRequests = new Map<
  number,
  { req: RequestHeaders; bodyChunks: Uint8Array[]; localUrl: string; ws: WebSocket }
>();

// Raw sockets for a proxied WebSocket upgrade, keyed by tunnel streamId, so
// subsequent FRAME_DATA/FRAME_END frames from the tunnel forward into them.
// FRAME_DATA payloads here are already-framed WebSocket wire bytes (produced
// by whatever real WebSocket client is on the browser/web end of the tunnel),
// so they're written to the socket verbatim rather than re-sent through a
// higher-level WebSocket client, which would re-frame and corrupt them.
const activeWsStreams = new Map<number, Socket>();

export function handleBodyFrame(streamId: number, type: number, payload: Uint8Array): void {
  const active = activeWsStreams.get(streamId);
  if (active) {
    if (type === FRAME_DATA) {
      active.write(Buffer.from(payload));
    } else if (type === FRAME_END) {
      activeWsStreams.delete(streamId);
      active.end();
    }
    return;
  }

  const pending = pendingRequests.get(streamId);
  if (!pending) return;

  if (type === FRAME_DATA) {
    pending.bodyChunks.push(payload);
  } else if (type === FRAME_END) {
    pendingRequests.delete(streamId);
    const totalLen = pending.bodyChunks.reduce((sum, c) => sum + c.length, 0);
    const body = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of pending.bodyChunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    doProxyToLocal(pending.ws, streamId, pending.req, pending.localUrl, body);
  }
}

function isWebSocketUpgrade(headers: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "upgrade" && v.toLowerCase() === "websocket") return true;
  }
  return false;
}

export function proxyToLocal(
  ws: WebSocket,
  streamId: number,
  req: RequestHeaders,
  localUrl: string
): Promise<void> | void {
  if (isWebSocketUpgrade(req.headers)) {
    return proxyWebSocketToLocal(ws, streamId, req, localUrl);
  }
  if (req.hasBody) {
    pendingRequests.set(streamId, { req, bodyChunks: [], localUrl, ws });
  } else {
    return doProxyToLocal(ws, streamId, req, localUrl, undefined);
  }
}

// Headers that only make sense framing the inbound hop; node's http client
// sets its own Host/Content-Length for the outbound request.
const WS_HOP_BY_HOP_HEADERS = new Set(["host", "content-length", "accept-encoding"]);

function sendResponseHeaders(ws: WebSocket, streamId: number, status: number, headers: Record<string, string>): void {
  const payload = new TextEncoder().encode(JSON.stringify({ status, headers } satisfies ResponseHeaders));
  ws.send(encodeFrame(streamId, FRAME_RESPONSE_HEADERS, payload));
}

function headerPairsToRecord(rawHeaders: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (let i = 0; i < rawHeaders.length; i += 2) headers[rawHeaders[i]] = rawHeaders[i + 1];
  return headers;
}

// Proxies a WebSocket upgrade request through to the local opencode server,
// mirroring gateway's proxyWebSocketUpgrade on the other end of the tunnel.
// This performs the HTTP upgrade for real (forwarding the original
// Sec-WebSocket-Key etc. so the local server computes a correct
// Sec-WebSocket-Accept), then relays the raw, already-framed WebSocket wire
// bytes byte-for-byte in both directions — the same raw-socket relay gateway
// itself does after hijacking the browser's connection. A FRAME_RESPONSE_HEADERS
// with status 101 signals gateway to hijack and start relaying FRAME_DATA/
// FRAME_END frames bidirectionally from then on.
function proxyWebSocketToLocal(
  ws: WebSocket,
  streamId: number,
  req: RequestHeaders,
  localUrl: string
): void {
  const target = new URL(req.path, localUrl);

  const fwdHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!WS_HOP_BY_HOP_HEADERS.has(k.toLowerCase())) fwdHeaders[k] = v;
  }

  const upgradeReq = httpRequest({
    hostname: target.hostname,
    port: target.port || 80,
    path: target.pathname + target.search,
    method: req.method,
    headers: fwdHeaders,
  });

  upgradeReq.on("upgrade", (res, socket) => {
    activeWsStreams.set(streamId, socket);
    sendResponseHeaders(ws, streamId, res.statusCode ?? 101, headerPairsToRecord(res.rawHeaders));

    socket.on("data", (chunk: Buffer) => {
      ws.send(encodeFrame(streamId, FRAME_DATA, new Uint8Array(chunk)));
    });
    socket.on("close", () => {
      activeWsStreams.delete(streamId);
      ws.send(encodeFrame(streamId, FRAME_END));
    });
    socket.on("error", () => {
      activeWsStreams.delete(streamId);
      ws.send(encodeFrame(streamId, FRAME_END));
    });
  });

  // The local server responded without upgrading (e.g. rejected the request) —
  // relay its response as a normal HTTP response instead.
  upgradeReq.on("response", (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => {
      sendResponseHeaders(ws, streamId, res.statusCode ?? 502, headerPairsToRecord(res.rawHeaders));
      const body = Buffer.concat(chunks);
      if (body.length > 0) ws.send(encodeFrame(streamId, FRAME_DATA, new Uint8Array(body)));
      ws.send(encodeFrame(streamId, FRAME_END));
    });
  });

  upgradeReq.on("error", (err: Error) => {
    activeWsStreams.delete(streamId);
    sendResponseHeaders(ws, streamId, 502, { "content-type": "text/plain" });
    const errBody = new TextEncoder().encode(`proxy error: ${err.message || String(err)}`);
    ws.send(encodeFrame(streamId, FRAME_DATA, errBody));
    ws.send(encodeFrame(streamId, FRAME_END));
  });

  upgradeReq.end();
}

async function doProxyToLocal(
  ws: WebSocket,
  streamId: number,
  req: RequestHeaders,
  localUrl: string,
  body: Uint8Array | undefined
): Promise<void> {
  const url = new URL(req.path, localUrl);

  try {
    const fwdHeaders = { ...req.headers };
    delete fwdHeaders["accept-encoding"];
    delete fwdHeaders["Accept-Encoding"];

    const resp = await fetch(url.toString(), {
      method: req.method,
      headers: fwdHeaders,
      body: body ? Buffer.from(body) : undefined,
    });

    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      if (k === "content-encoding" || k === "transfer-encoding" || k === "content-length") return;
      respHeaders[k] = v;
    });

    const respH: ResponseHeaders = {
      status: resp.status,
      headers: respHeaders,
    };
    const respPayload = new TextEncoder().encode(JSON.stringify(respH));
    ws.send(encodeFrame(streamId, FRAME_RESPONSE_HEADERS, respPayload));

    if (resp.body) {
      const reader = resp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (value && value.length > 0) {
          ws.send(encodeFrame(streamId, FRAME_DATA, value));
        }
        if (done) break;
      }
    }

    ws.send(encodeFrame(streamId, FRAME_END));
  } catch (err) {
    const errResp: ResponseHeaders = {
      status: 502,
      headers: { "content-type": "text/plain" },
    };
    const payload = new TextEncoder().encode(JSON.stringify(errResp));
    ws.send(encodeFrame(streamId, FRAME_RESPONSE_HEADERS, payload));
    const errBody = new TextEncoder().encode(
      `proxy error: ${err instanceof Error ? err.message : String(err)}`
    );
    ws.send(encodeFrame(streamId, FRAME_DATA, errBody));
    ws.send(encodeFrame(streamId, FRAME_END));
  }
}

export interface TunnelHandle {
  close(): void;
  disconnected: Promise<void>;
}

export async function startTunnel(
  config: Config,
  idToken: string,
  sessionID: string,
  localUrl: string,
  directory: string
): Promise<TunnelHandle> {
  const baseUrl = config.gatewayUrl.replace(/\/$/, "");
  const tunnelPath = `/tunnel?sessionId=${encodeURIComponent(sessionID)}&directory=${encodeURIComponent(directory)}`;

  // Pre-flight: plain HTTP request to surface auth/network errors
  // before the opaque WebSocket upgrade failure.
  // Expected responses (server reachable, needs WS): 400, 426, 405.
  // Actionable errors worth reporting early: 401, 403, 5xx.
  try {
    const resp = await fetch(`${baseUrl}${tunnelPath}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${idToken}` },
    });
    const preflightOk = [400, 405, 426];
    if (!preflightOk.includes(resp.status) && (resp.status === 401 || resp.status === 403 || resp.status >= 500)) {
      const body = await resp.text().catch(() => "");
      const msg = `Tunnel pre-flight failed: ${resp.status} ${resp.statusText}${body ? " — " + body.trim() : ""}`;
      console.error(msg);
      throw new Error(msg);
    }
  } catch (err: any) {
    if (err.message?.startsWith("Tunnel pre-flight")) throw err;
    console.error(`Tunnel pre-flight network error: ${err.message} (url: ${baseUrl}${tunnelPath})`);
    throw err;
  }

  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace(/^http/, "ws");
    const url = `${wsUrl}${tunnelPath}`;

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });

    ws.binaryType = "arraybuffer";
    let resolveDisconnected: () => void;
    const disconnected = new Promise<void>((r) => { resolveDisconnected = r; });

    ws.on("open", () => {
      connected = true;
      console.log("Tunnel established");
      resolve({
        close() {
          ws.close();
        },
        disconnected,
      });
    });

    ws.on("message", (data: Buffer | ArrayBuffer) => {
      let buf: ArrayBuffer;
      if (data instanceof ArrayBuffer) {
        buf = data;
      } else if (Buffer.isBuffer(data)) {
        buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      } else {
        return;
      }

      if (buf.byteLength < 5) return;

      const frame = decodeFrameHeader(buf);

      if (frame.type === FRAME_REQUEST_HEADERS) {
        const json = new TextDecoder().decode(frame.payload);
        const req: RequestHeaders = JSON.parse(json);
        proxyToLocal(ws as unknown as WebSocket, frame.streamId, req, localUrl);
      } else if (frame.type === FRAME_DATA || frame.type === FRAME_END) {
        handleBodyFrame(frame.streamId, frame.type, frame.payload);
      }
    });

    let connected = false;
    let rejected = false;

    function rejectOnce(detail: string) {
      if (rejected) return;
      rejected = true;
      console.error(`  Reason: ${detail}`);
      console.error("  Check that the gateway URL is correct and the gateway is accepting WebSocket connections.");
      reject(new Error(`tunnel connection failed: ${detail}`));
    }

    ws.on("error", (err: Error) => {
      if (!connected) {
        console.error(`Tunnel WebSocket connection failed: ${url}`);
        if (err.message) console.error(`  Error: ${err.message}`);
        rejectOnce(err.message || "connection failed");
      } else {
        console.error(`Tunnel WebSocket error: ${err.message || "connection failed"}`);
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason.toString();
      if (!connected) {
        const hints: string[] = [];
        if (code === 1006) hints.push("connection was closed abnormally (no close frame received)");
        if (code === 401 || reasonStr.includes("auth")) hints.push("authentication may have failed — try logging in again");
        const detail = reasonStr || hints.join("; ") || `close code ${code}`;
        rejectOnce(detail);
      } else {
        console.log("Tunnel closed");
      }
      resolveDisconnected();
    });
  });
}

export async function startTunnelWithReconnect(
  config: Config,
  idToken: string,
  sessionID: string,
  localUrl: string,
  directory: string
): Promise<TunnelHandle> {
  let closed = false;
  let currentHandle: TunnelHandle | null = null;

  async function connectLoop(): Promise<void> {
    let backoff = 1000;
    while (!closed) {
      try {
        currentHandle = await startTunnel(
          config,
          idToken,
          sessionID,
          localUrl,
          directory
        );
        backoff = 1000;
        await currentHandle.disconnected;
        if (!closed) {
          console.log("Tunnel disconnected, will reconnect...");
        }
      } catch (err) {
        if (closed) return;
        console.error(`Tunnel error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!closed) {
        console.log(`Reconnecting in ${backoff / 1000}s...`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }

  // Initial connection — throw on failure so caller sees it
  let backoff = 1000;
  while (!closed) {
    try {
      currentHandle = await startTunnel(
        config,
        idToken,
        sessionID,
        localUrl,
        directory
      );
      break;
    } catch (err) {
      if (closed) throw new Error("tunnel closed");
      console.error(`Tunnel error: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`Reconnecting in ${backoff / 1000}s...`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }

  if (!currentHandle) throw new Error("tunnel closed");

  // After initial connect, run reconnection loop in background
  currentHandle.disconnected.then(() => {
    if (!closed) {
      console.log("Tunnel disconnected, will reconnect...");
      connectLoop();
    }
  });

  let resolveOuter: () => void;
  const outerDisconnected = new Promise<void>((r) => { resolveOuter = r; });

  return {
    close() {
      closed = true;
      currentHandle?.close();
      resolveOuter();
    },
    disconnected: outerDisconnected,
  };
}
