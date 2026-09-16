import { createHmac, randomBytes } from "node:crypto";

export interface SessionData {
  uid: string;
  email: string;
  name: string;
  exp: number;
}

function sign(payload: string, secret: Uint8Array): string {
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function verify(signed: string, secret: Uint8Array): string | null {
  const lastDot = signed.lastIndexOf(".");
  if (lastDot < 0) return null;
  const payload = signed.substring(0, lastDot);
  const expected = sign(payload, secret);
  if (expected !== signed) return null;
  return payload;
}

export function encodeCookie(data: SessionData, secret: Uint8Array): string {
  const json = JSON.stringify(data);
  const b64 = Buffer.from(json).toString("base64url");
  return sign(b64, secret);
}

export function decodeCookie(
  value: string,
  secret: Uint8Array
): SessionData | null {
  const payload = verify(value, secret);
  if (!payload) return null;
  try {
    const json = Buffer.from(payload, "base64url").toString();
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function generateState(): string {
  return randomBytes(16).toString("hex");
}
