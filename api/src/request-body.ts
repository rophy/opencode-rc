import type { Context } from "hono";
import type { ProxyEnv } from "./proxy.js";

// The largest body a guard reads: above opencode's 20 MB attachment limit (2.x core
// session/prompt.ts MAX_ATTACHMENT_BYTES) once base64 and JSON are added.
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

export type JsonBody = { json: unknown } | "not-json" | "too-large";

// The body, or undefined once it is larger than MAX_BODY_BYTES (by Content-Length, or while
// reading when the length is not declared or is wrong).
async function readCapped(req: Request): Promise<ArrayBuffer | undefined> {
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) return undefined;
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

// The request body as JSON, for guards that check it. The bytes are read once and kept in
// c.var.body: a second guard on the same request reuses them, and the proxy forwards exactly
// what was checked. An empty body has no fields to check (json is undefined).
export async function jsonBody(c: Context<ProxyEnv>): Promise<JsonBody> {
  let body = c.get("body");
  if (body === undefined) {
    const read = await readCapped(c.req.raw);
    if (!read) return "too-large";
    body = read;
    c.set("body", body);
  }
  const text = new TextDecoder().decode(body);
  if (text.trim() === "") return { json: undefined };
  try {
    return { json: JSON.parse(text) };
  } catch {
    return "not-json";
  }
}

// What a 1.x guard answers for a body it cannot check.
export function bodyError(c: Context<ProxyEnv>, error: "not-json" | "too-large"): Response {
  return error === "too-large" ? c.text("request body is too large", 413) : c.text("request body is not JSON", 400);
}
