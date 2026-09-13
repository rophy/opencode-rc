import type { Config } from "./config.js";

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

export async function proxyToLocal(
  ws: WebSocket,
  streamId: number,
  req: RequestHeaders,
  localUrl: string
): Promise<void> {
  const url = new URL(req.path, localUrl);

  try {
    const resp = await fetch(url.toString(), {
      method: req.method,
      headers: req.headers,
    });

    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
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
    // Send error response
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
}

export function startTunnel(
  config: Config,
  idToken: string,
  sessionID: string,
  localUrl: string,
  directory: string
): Promise<TunnelHandle> {
  return new Promise((resolve, reject) => {
    const gatewayWsUrl = config.gatewayUrl
      .replace(/^http/, "ws")
      .replace(/\/$/, "");
    const url = `${gatewayWsUrl}/gateway/tunnel?sessionId=${encodeURIComponent(sessionID)}&directory=${encodeURIComponent(directory)}`;

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    } as any);

    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      console.log("Tunnel established to gateway");
      resolve({
        close() {
          ws.close();
        },
      });
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      let data: ArrayBuffer;
      if (event.data instanceof ArrayBuffer) {
        data = event.data;
      } else if (ArrayBuffer.isView(event.data)) {
        const view = event.data;
        data = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
      } else {
        return;
      }

      if (data.byteLength < 5) return;

      const frame = decodeFrameHeader(data);

      if (frame.type === FRAME_REQUEST_HEADERS) {
        const json = new TextDecoder().decode(frame.payload);
        const req: RequestHeaders = JSON.parse(json);
        proxyToLocal(ws, frame.streamId, req, localUrl);
      }
    });

    ws.addEventListener("error", (event: Event) => {
      const err = event as ErrorEvent;
      console.error(`Tunnel error: ${err.message || "connection error"}`);
      reject(new Error("tunnel connection failed"));
    });

    ws.addEventListener("close", () => {
      console.log("Tunnel closed");
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

  async function connect() {
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
        return currentHandle;
      } catch {
        console.log(`Reconnecting in ${backoff / 1000}s...`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
    throw new Error("tunnel closed");
  }

  const handle = await connect();

  return {
    close() {
      closed = true;
      currentHandle?.close();
    },
  };
}
