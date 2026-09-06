// cli/src/config.ts

export interface Config {
  gatewayUrl: string;
  oidcIssuer: string;
  oidcClientID: string;
  oidcClientSecret?: string;
  oidcTokenEndpoint: string;
  oidcAuthorizationEndpoint: string;
  oidcCallbackPorts?: number[];
}

interface OIDCDiscovery {
  token_endpoint: string;
  authorization_endpoint: string;
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
  const gatewayUrl = process.env.OPENCODE_RC_GATEWAY_URL;
  if (!gatewayUrl) throw new Error("OPENCODE_RC_GATEWAY_URL is required");

  const oidcIssuer = process.env.OIDC_ISSUER;
  if (!oidcIssuer) throw new Error("OIDC_ISSUER is required");

  const oidcClientID = process.env.OIDC_CLIENT_ID;
  if (!oidcClientID) throw new Error("OIDC_CLIENT_ID is required");

  const discovery = await discoverOIDC(oidcIssuer);

  const oidcTokenEndpoint =
    process.env.OIDC_TOKEN_ENDPOINT || discovery.token_endpoint;

  const oidcAuthorizationEndpoint =
    process.env.OIDC_AUTHORIZATION_ENDPOINT || discovery.authorization_endpoint;

  const oidcClientSecret = process.env.OIDC_CLIENT_SECRET || undefined;

  let oidcCallbackPorts: number[] | undefined;
  if (process.env.OIDC_CALLBACK_PORTS) {
    oidcCallbackPorts = process.env.OIDC_CALLBACK_PORTS
      .split(",")
      .map((s) => parseInt(s.trim(), 10));
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
