import * as jose from "jose";

export interface OIDCDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

export interface OIDCProvider {
  discovery: OIDCDiscovery;
  jwks: ReturnType<typeof jose.createRemoteJWKSet>;
}

export async function discoverOIDC(
  issuer: string,
  overrides?: Partial<OIDCDiscovery>,
  maxRetries = 30
): Promise<OIDCDiscovery> {
  let lastErr: Error | undefined;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const res = await fetch(
        `${issuer}/.well-known/openid-configuration`
      );
      if (!res.ok) {
        throw new Error(`OIDC discovery: ${res.status} ${await res.text()}`);
      }
      const discovery: OIDCDiscovery = await res.json();
      if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
          if (value) {
            (discovery as any)[key] = value;
            console.log(`OIDC discovery override: ${key}`);
          }
        }
      }
      return discovery;
    } catch (err) {
      lastErr = err as Error;
      if (i < maxRetries) {
        console.warn(`OIDC discovery retry ${i}: ${lastErr.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  throw new Error(
    `OIDC discovery failed after ${maxRetries} attempts: ${lastErr?.message}`
  );
}

export function createProvider(discovery: OIDCDiscovery): OIDCProvider {
  const jwks = jose.createRemoteJWKSet(new URL(discovery.jwks_uri));
  return { discovery, jwks };
}

export async function verifyToken(
  provider: OIDCProvider,
  token: string,
  audience: string
): Promise<jose.JWTPayload> {
  const { payload } = await jose.jwtVerify(token, provider.jwks, {
    issuer: provider.discovery.issuer,
    audience,
  });
  return payload;
}
