import type { MiddlewareHandler } from "hono";

// Client/server compatibility, independent of release versions (docs/api-versioning.md).
// Bump PROTOCOL for changes old clients cannot handle; raise MIN_CLIENT_PROTOCOL when
// those clients are no longer supported.
export const PROTOCOL_HEADER = "OpenCode-RC-Protocol";
export const PROTOCOL = 1;
export const MIN_CLIENT_PROTOCOL = 1;

export function readProtocol(value: string | null | undefined): number {
  return value && /^\d+$/.test(value) ? Number(value) : 0;
}

export function protocolHeader(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.res.headers.set(PROTOCOL_HEADER, String(PROTOCOL));
  };
}

export function requireClientProtocol(): MiddlewareHandler {
  return async (c, next) => {
    const client = readProtocol(c.req.header(PROTOCOL_HEADER));
    if (client < MIN_CLIENT_PROTOCOL) {
      return c.json(
        { error: "client_outdated", client, minimum: MIN_CLIENT_PROTOCOL, server: PROTOCOL },
        426,
      );
    }
    await next();
  };
}
