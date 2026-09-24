import type { Context, MiddlewareHandler } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { ProxyEnv } from "./proxy.js";
import { proxyRest, upstreamUrl } from "./proxy.js";
import { relayCloseCode } from "./ws-close.js";

export { relayCloseCode };

export function isUpgrade(c: Context): boolean {
  return (c.req.header("upgrade") ?? "").toLowerCase() === "websocket";
}

type Frame = string | ArrayBuffer;

const upgrade = upgradeWebSocket((c: Context<ProxyEnv>) => {
  const meta = c.get("session");
  const token = c.get("token");
  const target = upstreamUrl(
    "ws",
    meta.gatewayAddr,
    meta.id,
    proxyRest(c.req.path, meta.id),
    new URL(c.req.url).search,
  );

  let upstream: WebSocket | undefined;
  const pending: Frame[] = [];

  return {
    onOpen(_evt, ws) {
      // Bun's WebSocket client accepts headers in the second argument.
      upstream = new WebSocket(target, {
        headers: { Authorization: `Bearer ${token}` },
      } as unknown as string[]);
      upstream.binaryType = "arraybuffer";
      upstream.onopen = () => {
        for (const frame of pending.splice(0)) upstream!.send(frame);
      };
      upstream.onmessage = (e) => ws.send(e.data as Frame);
      upstream.onclose = (e) => ws.close(relayCloseCode(e.code), e.reason);
      upstream.onerror = () => ws.close(1011, "upstream error");
    },
    onMessage(evt) {
      const frame = evt.data as Frame;
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(frame);
      else pending.push(frame);
    },
    onClose() {
      upstream?.close();
    },
  };
});

export function wsRelay(): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    if (!isUpgrade(c)) return next();
    return upgrade(c, next);
  };
}
