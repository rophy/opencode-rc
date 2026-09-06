// cli/src/config.ts

export interface Config {
  gatewayUrl: string;
  oidcIssuer: string;
  oidcClientID: string;
  oidcTokenEndpoint: string;
}

export function loadConfig(): Config {
  const gatewayUrl = process.env.OPENCODE_RC_GATEWAY_URL;
  if (!gatewayUrl) throw new Error("OPENCODE_RC_GATEWAY_URL is required");

  const oidcIssuer = process.env.OIDC_ISSUER;
  if (!oidcIssuer) throw new Error("OIDC_ISSUER is required");

  const oidcClientID = process.env.OIDC_CLIENT_ID;
  if (!oidcClientID) throw new Error("OIDC_CLIENT_ID is required");

  const oidcTokenEndpoint =
    process.env.OIDC_TOKEN_ENDPOINT || `${oidcIssuer}/oauth/token`;

  return { gatewayUrl, oidcIssuer, oidcClientID, oidcTokenEndpoint };
}
