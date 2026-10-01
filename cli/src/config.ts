import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Config {
  gatewayUrl: string;
  oidcIssuer: string;
  oidcClientID: string;
  oidcClientSecret?: string;
  oidcTokenEndpoint: string;
  oidcAuthorizationEndpoint: string;
  oidcCallbackPorts?: number[];
}

interface FileConfig {
  gatewayUrl?: string;
  oidc?: {
    issuer?: string; // ignored, the server provides it
    clientId?: string; // ignored, the server provides it
    clientSecret?: string;
    callbackPorts?: number[];
  };
}

interface OIDCDiscovery {
  token_endpoint: string;
  authorization_endpoint: string;
}

async function loadFileConfig(): Promise<FileConfig> {
  const xdgConfig =
    process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config");
  const configPath = join(xdgConfig, "opencode", "rc.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function applyTLSInsecure() {
  if (process.env.TLS_INSECURE_SKIP_VERIFY === "true" && process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    console.warn("Warning: TLS certificate verification disabled");
  }
}

async function discoverOIDC(issuer: string): Promise<OIDCDiscovery> {
  const res = await fetch(
    `${issuer}/.well-known/openid-configuration`
  );
  if (!res.ok) {
    throw new Error(
      `OIDC discovery failed: ${res.status} ${await res.text()}`
    );
  }
  return res.json();
}

// The server publishes its issuer and CLI client ID at /auth/cli-config (api and
// gateway 0.7.0+). It only accepts tokens from that issuer and client, so the CLI
// has nothing to override.
async function fetchServerConfig(gatewayUrl: string): Promise<{ issuer: string; clientId: string }> {
  const url = `${gatewayUrl.replace(/\/$/, "")}/auth/cli-config`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause : err).message : err;
    throw new Error(`Cannot reach ${url}: ${cause}`);
  }
  if (res.status === 404) {
    throw new Error(`The server at ${gatewayUrl} does not provide /auth/cli-config; ask its administrator to upgrade it`);
  }
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const body = await res.json().catch(() => undefined);
  if (typeof body?.issuer !== "string" || !body.issuer) throw new Error("The server returned no OIDC issuer");
  if (typeof body?.clientId !== "string" || !body.clientId) {
    throw new Error("The server returned no CLI client ID; ask its administrator to set oidc.cliClientId");
  }
  return { issuer: body.issuer, clientId: body.clientId };
}

export async function loadConfig(): Promise<Config> {
  applyTLSInsecure();
  const file = await loadFileConfig();

  const gatewayUrl = process.env.OPENCODE_RC_GATEWAY_URL || file.gatewayUrl;
  if (!gatewayUrl) throw new Error("OPENCODE_RC_GATEWAY_URL is required (env or ~/.config/opencode/rc.json)");

  if (process.env.OIDC_ISSUER || process.env.OIDC_CLIENT_ID || file.oidc?.issuer || file.oidc?.clientId) {
    console.warn("Warning: ignoring the configured OIDC issuer and client ID; the server provides them");
  }
  const { issuer: oidcIssuer, clientId: oidcClientID } = await fetchServerConfig(gatewayUrl);

  const discovery = await discoverOIDC(oidcIssuer);

  const oidcTokenEndpoint =
    process.env.OIDC_TOKEN_ENDPOINT || discovery.token_endpoint;

  const oidcAuthorizationEndpoint =
    process.env.OIDC_AUTHORIZATION_ENDPOINT || discovery.authorization_endpoint;

  const oidcClientSecret =
    process.env.OIDC_CLIENT_SECRET || file.oidc?.clientSecret || undefined;

  let oidcCallbackPorts: number[] | undefined;
  if (process.env.OIDC_CALLBACK_PORTS) {
    oidcCallbackPorts = process.env.OIDC_CALLBACK_PORTS
      .split(",")
      .map((s) => parseInt(s.trim(), 10));
  } else if (file.oidc?.callbackPorts) {
    oidcCallbackPorts = file.oidc.callbackPorts;
  }

  return {
    gatewayUrl,
    oidcIssuer,
    oidcClientID,
    oidcClientSecret,
    oidcTokenEndpoint,
    oidcAuthorizationEndpoint,
    oidcCallbackPorts,
  };
}
