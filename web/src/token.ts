import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface AccessClaims {
  uid: string;
  email: string;
  name: string;
}

interface AccessPayload extends AccessClaims {
  typ: "access";
  exp: number;
}

function mac(payload: string, secret: Uint8Array): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signAccessToken(
  claims: AccessClaims,
  secret: Uint8Array,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const body: AccessPayload = {
    typ: "access",
    uid: claims.uid,
    email: claims.email,
    name: claims.name,
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${mac(payload, secret)}`;
}

export function verifyAccessToken(
  token: string,
  secret: Uint8Array,
  now = Date.now(),
): AccessClaims | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const got = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(mac(payload, secret));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;

  let body: Partial<AccessPayload>;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (body.typ !== "access" || typeof body.exp !== "number" || typeof body.uid !== "string") {
    return null;
  }
  if (Math.floor(now / 1000) >= body.exp) return null;
  return { uid: body.uid, email: body.email ?? "", name: body.name ?? "" };
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// PKCE (RFC 7636, S256): the login code is bound to the client that started the login.
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export function isCodeChallenge(value: unknown): value is string {
  return typeof value === "string" && CODE_CHALLENGE.test(value);
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifyCodeVerifier(verifier: string | null, challenge: string): boolean {
  if (!verifier || !CODE_VERIFIER.test(verifier)) return false;
  const got = Buffer.from(codeChallenge(verifier));
  const want = Buffer.from(challenge);
  return got.length === want.length && timingSafeEqual(got, want);
}
