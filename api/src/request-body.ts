import type { Context } from "hono";
import type { ProxyEnv } from "./proxy.js";

// The request body as JSON, for guards that check it. The bytes are read once and kept in
// c.var.body: a second guard on the same request reuses them, and the proxy forwards exactly
// what was checked. undefined when the body is not JSON.
export async function jsonBody(c: Context<ProxyEnv>): Promise<{ json: unknown } | undefined> {
  let body = c.get("body");
  if (body === undefined) {
    body = await c.req.raw.arrayBuffer();
    c.set("body", body);
  }
  try {
    return { json: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return undefined;
  }
}
