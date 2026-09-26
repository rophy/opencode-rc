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
  tokenSecret: Uint8Array;
  accessTokenTtl: number;
  sessionTtl: number;
  allowedOrigins: string[];
  /** OIDC prompt for mobile app logins ("" = none); see appLoginPrompt() */
  appLoginPrompt: string;
  secureCookies: boolean;
  redisUrl: string;
  gatewayUrl: string;
  tlsInsecureSkipVerify: boolean;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} is required`);
  return val;
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) throw new Error(`invalid duration: ${value}`);
  const seconds = parseInt(match[1], 10) * UNITS[match[2]];
  if (seconds <= 0) throw new Error(`duration must be positive: ${value}`);
  return seconds;
}

const APP_LOGIN_PROMPTS = ["select_account", "login", "consent", ""];

// The mobile app's callback scheme cannot identify the app (RFC 8252 section 8.6), so app
// logins ask the IdP to make the user interact. An IdP that ignores the value logs in silently.
function appLoginPrompt(value: string | undefined): string {
  const prompt = value ?? "select_account";
  if (!APP_LOGIN_PROMPTS.includes(prompt)) {
    throw new Error(`APP_LOGIN_PROMPT must be one of select_account, login, consent or empty, got "${prompt}"`);
  }
  return prompt;
}

export function loadConfig(): Config {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

  const secretHex = process.env.TOKEN_SECRET || process.env.COOKIE_SECRET;
  if (!secretHex) throw new Error("TOKEN_SECRET is required");
  const secret = Buffer.from(secretHex, "hex");
  if (secret.length !== 32) {
    throw new Error("TOKEN_SECRET must be a 64-char hex string (32 bytes)");
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
    tokenSecret: new Uint8Array(secret),
    accessTokenTtl: parseDuration(process.env.ACCESS_TOKEN_TTL || "15m"),
    sessionTtl: parseDuration(process.env.SESSION_TTL || "7d"),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    appLoginPrompt: appLoginPrompt(process.env.APP_LOGIN_PROMPT),
    secureCookies: process.env.COOKIE_SECURE !== "false",
    redisUrl: requireEnv("REDIS_URL"),
    gatewayUrl: process.env.GATEWAY_URL ?? "",
    tlsInsecureSkipVerify: process.env.TLS_INSECURE_SKIP_VERIFY === "true",
  };
}
