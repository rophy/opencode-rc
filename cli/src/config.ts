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
    issuer?: string;
    clientId?: string;
    clientSecret?: string;
    callbackPorts?: number[];
  };
}

interface ServerConfig {
  issuer?: string;
  clientId?: string;
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

const NOT_FROM_SERVER = "not provided by the server";

// The server publishes its issuer and CLI client ID at /auth/cli-config.
// Returns {} if the server is unreachable or predates the endpoint.
async function fetchServerConfig(gatewayUrl: string): Promise<ServerConfig> {
  try {
    const res = await fetch(`${gatewayUrl.replace(/\/$/, "")}/auth/cli-config`);
    if (!res.ok) return {};
    const body = await res.json();
    return {
      issuer: typeof body?.issuer === "string" ? body.issuer : undefined,
      clientId: typeof body?.clientId === "string" ? body.clientId : undefined,
    };
  } catch {
    return {};
  }
}

export async function loadConfig(): Promise<Config> {
  applyTLSInsecure();
  const file = await loadFileConfig();

  const gatewayUrl = process.env.OPENCODE_RC_GATEWAY_URL || file.gatewayUrl;
  if (!gatewayUrl) throw new Error("OPENCODE_RC_GATEWAY_URL is required (env or ~/.config/opencode/rc.json)");

  let oidcIssuer = process.env.OIDC_ISSUER || file.oidc?.issuer;
  let oidcClientID = process.env.OIDC_CLIENT_ID || file.oidc?.clientId;
  if (!oidcIssuer || !oidcClientID) {
    const server = await fetchServerConfig(gatewayUrl);
    oidcIssuer ||= server.issuer;
    oidcClientID ||= server.clientId;
  }
  if (!oidcIssuer) throw new Error(`OIDC_ISSUER is required (env or ~/.config/opencode/rc.json); ${NOT_FROM_SERVER}`);
  if (!oidcClientID) throw new Error(`OIDC_CLIENT_ID is required (env or ~/.config/opencode/rc.json); ${NOT_FROM_SERVER}`);

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
