// cli/src/oidc.ts

import type { Config } from "./config.js";

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  id_token: string;
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

export async function deviceFlowAuth(
  config: Config
): Promise<{ idToken: string; expiresAt: number }> {
  // Step 1: Request device code
  const deviceEndpoint =
    process.env.OIDC_DEVICE_ENDPOINT ||
    `${config.oidcIssuer}/oauth/device/code`;

  const deviceRes = await fetch(deviceEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.oidcClientID,
      scope: "openid email profile",
    }),
  });

  if (!deviceRes.ok) {
    throw new Error(
      `Device auth request failed: ${deviceRes.status} ${await deviceRes.text()}`
    );
  }

  const device: DeviceAuthResponse = await deviceRes.json();

  console.log("\nTo authenticate, open this URL in your browser:");
  console.log(`  ${device.verification_uri_complete || device.verification_uri}`);
  console.log(`\nEnter code: ${device.user_code}\n`);

  // Step 2: Poll for token
  const interval = (device.interval || 5) * 1000;
  const deadline = Date.now() + device.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));

    const tokenRes = await fetch(config.oidcTokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: config.oidcClientID,
        device_code: device.device_code,
      }),
    });

    if (tokenRes.ok) {
      const token: TokenResponse = await tokenRes.json();
      return {
        idToken: token.id_token,
        expiresAt: Date.now() + token.expires_in * 1000,
      };
    }

    const err: TokenErrorResponse = await tokenRes.json();
    if (err.error === "authorization_pending") continue;
    if (err.error === "slow_down") {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    throw new Error(`Token error: ${err.error} — ${err.error_description}`);
  }

  throw new Error("Device flow timed out — user did not authorize in time");
}
