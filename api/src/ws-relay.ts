import type { Context, MiddlewareHandler } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSEvents } from "hono/ws";
import type { ProxyEnv } from "./proxy.js";
import { proxyRest, upstreamUrl } from "./proxy.js";
import { closeReason, relayCloseCode } from "./ws-close.js";

export { relayCloseCode };

export function isUpgrade(c: Context): boolean {
  return (c.req.header("upgrade") ?? "").toLowerCase() === "websocket";
}

type Frame = string | ArrayBuffer;

// The relay's WebSocket handlers for one connection: client <-> gateway.
export function relayEvents(c: Context<ProxyEnv>) {
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
  let stopWatch = () => {};

  return {
    onOpen(_evt, ws) {
      // A revoked user's terminal closes at the next re-check (1008: policy violation).
      stopWatch =
        c.get("watchAccess")?.((decision) => {
          ws.close(1008, closeReason(decision.reason ?? "access revoked"));
          upstream?.close(1000, "access revoked");
        }) ?? stopWatch;
      // Bun's WebSocket client accepts headers in the second argument.
      upstream = new WebSocket(target, {
        headers: { Authorization: `Bearer ${token}` },
      } as unknown as string[]);
      upstream.binaryType = "arraybuffer";
      upstream.onopen = () => {
        for (const frame of pending.splice(0)) upstream!.send(frame);
      };
      upstream.onmessage = (e) => ws.send(e.data as Frame);
      upstream.onclose = (e) => {
        stopWatch();
        ws.close(relayCloseCode(e.code), e.reason);
      };
      upstream.onerror = () => ws.close(1011, "upstream error");
    },
    onMessage(evt) {
      const frame = evt.data as Frame;
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(frame);
      else pending.push(frame);
    },
    onClose(evt) {
      stopWatch();
      upstream?.close(relayCloseCode(evt.code), evt.reason);
    },
  } satisfies WSEvents;
}

const upgrade = upgradeWebSocket(relayEvents);

export function wsRelay(): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    if (c.req.method !== "GET" || !isUpgrade(c)) return next();
    return upgrade(c, next);
  };
}
