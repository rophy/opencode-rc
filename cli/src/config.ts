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

export async function loadConfig(): Promise<Config> {
  const file = await loadFileConfig();

  const gatewayUrl = process.env.OPENCODE_RC_GATEWAY_URL || file.gatewayUrl;
  if (!gatewayUrl) throw new Error("OPENCODE_RC_GATEWAY_URL is required (env or ~/.config/opencode/rc.json)");

  const oidcIssuer = process.env.OIDC_ISSUER || file.oidc?.issuer;
  if (!oidcIssuer) throw new Error("OIDC_ISSUER is required (env or ~/.config/opencode/rc.json)");

  const oidcClientID = process.env.OIDC_CLIENT_ID || file.oidc?.clientId;
  if (!oidcClientID) throw new Error("OIDC_CLIENT_ID is required (env or ~/.config/opencode/rc.json)");

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
