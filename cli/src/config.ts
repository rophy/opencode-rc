import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Config {
  tunnelerUrl: string;
  oidcIssuer: string;
  oidcClientID: string;
  oidcClientSecret?: string;
  oidcTokenEndpoint: string;
  oidcAuthorizationEndpoint: string;
  oidcCallbackPorts?: number[];
}

interface FileConfig {
  tunnelerUrl?: string;
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

export async function loadConfig(): Promise<Config> {
  applyTLSInsecure();
  const file = await loadFileConfig();

  const tunnelerUrl = process.env.OPENCODE_RC_TUNNELER_URL || file.tunnelerUrl;
  if (!tunnelerUrl) throw new Error("OPENCODE_RC_TUNNELER_URL is required (env or ~/.config/opencode/rc.json)");

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
    tunnelerUrl,
    oidcIssuer,
    oidcClientID,
    oidcClientSecret,
    oidcTokenEndpoint,
    oidcAuthorizationEndpoint,
    oidcCallbackPorts,
  };
}
