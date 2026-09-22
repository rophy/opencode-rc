export interface Config {
  port: number;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcCliClientId: string;
  oidcRedirectUri: string;
  oidcIssuerOverride: string;
  oidcAuthorizationEndpoint: string;
  oidcTokenEndpoint: string;
  oidcJwksUri: string;
  cookieSecret: Uint8Array;
  cookieDomain: string;
  secureCookies: boolean;
  redisUrl: string;
  webUiDir: string;
  gatewayUrl: string;
  tlsInsecureSkipVerify: boolean;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} is required`);
  return val;
}

export function loadConfig(): Config {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

  const secretHex = requireEnv("COOKIE_SECRET");
  const secret = Buffer.from(secretHex, "hex");
  if (secret.length !== 32) {
    throw new Error("COOKIE_SECRET must be a 64-char hex string (32 bytes)");
  }

  return {
    port,
    oidcIssuer: requireEnv("OIDC_ISSUER"),
    oidcClientId: requireEnv("OIDC_CLIENT_ID"),
    oidcClientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
    oidcCliClientId: process.env.OIDC_CLI_CLIENT_ID ?? "",
    oidcRedirectUri: requireEnv("OIDC_REDIRECT_URI"),
    oidcIssuerOverride: process.env.OIDC_ISSUER_OVERRIDE ?? "",
    oidcAuthorizationEndpoint: process.env.OIDC_AUTHORIZATION_ENDPOINT ?? "",
    oidcTokenEndpoint: process.env.OIDC_TOKEN_ENDPOINT ?? "",
    oidcJwksUri: process.env.OIDC_JWKS_URI ?? "",
    cookieSecret: new Uint8Array(secret),
    cookieDomain: process.env.COOKIE_DOMAIN ?? "",
    secureCookies: process.env.COOKIE_SECURE !== "false",
    redisUrl: requireEnv("REDIS_URL"),
    webUiDir: process.env.WEBUI_DIR ?? "",
    gatewayUrl: process.env.GATEWAY_URL ?? "",
    tlsInsecureSkipVerify: process.env.TLS_INSECURE_SKIP_VERIFY === "true",
  };
}
