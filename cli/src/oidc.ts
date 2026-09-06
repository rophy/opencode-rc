// cli/src/oidc.ts — Authorization Code Flow with PKCE via local callback server

import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";
import type { Config } from "./config.js";

const DEFAULT_CALLBACK_PORTS = [43212, 43213, 43214, 43215];

interface TokenResponse {
  id_token: string;
  access_token: string;
  token_type: string;
  expires_in: number;
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function authorizationCodeAuth(
  config: Config
): Promise<{ idToken: string; expiresAt: number }> {
  const state = randomBytes(16).toString("hex");
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const { code, redirectUri } = await getAuthorizationCode(
    config,
    state,
    codeChallenge
  );

  const tokenParams: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: config.oidcClientID,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };
  if (config.oidcClientSecret) {
    tokenParams.client_secret = config.oidcClientSecret;
  }

  const tokenRes = await fetch(config.oidcTokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(tokenParams),
  });

  if (!tokenRes.ok) {
    throw new Error(
      `Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`
    );
  }

  const token: TokenResponse = await tokenRes.json();
  return {
    idToken: token.id_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
}

function listenOnAvailablePort(server: Server, ports: number[]): Promise<number> {
  return new Promise((resolve, reject) => {
    let index = 0;

    function tryNext() {
      if (index >= ports.length) {
        reject(new Error(`All callback ports in use (tried ${ports.join(", ")})`));
        return;
      }
      const port = ports[index++];
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          tryNext();
        } else {
          reject(err);
        }
      });
      server.listen(port, "127.0.0.1", () => resolve(port));
    }

    tryNext();
  });
}

function getAuthorizationCode(
  config: Config,
  state: string,
  codeChallenge: string
): Promise<{ code: string; redirectUri: string }> {
  const ports = config.oidcCallbackPorts ?? DEFAULT_CALLBACK_PORTS;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authentication failed</h1><p>You can close this tab.</p></body></html>");
        server.close();
        reject(
          new Error(
            `Authorization error: ${error} — ${url.searchParams.get("error_description") || ""}`
          )
        );
        return;
      }

      const returnedState = url.searchParams.get("state");
      if (returnedState !== state) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authentication failed</h1><p>State mismatch. You can close this tab.</p></body></html>");
        server.close();
        reject(new Error("State mismatch in callback"));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authentication failed</h1><p>No code received. You can close this tab.</p></body></html>");
        server.close();
        reject(new Error("No authorization code in callback"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Authenticated!</h1><p>You can close this tab and return to the terminal.</p></body></html>");

      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close();
      resolve({ code, redirectUri: `http://127.0.0.1:${port}/callback` });
    });

    listenOnAvailablePort(server, ports)
      .then((port) => {
        const redirectUri = `http://127.0.0.1:${port}/callback`;

        const params = new URLSearchParams({
          response_type: "code",
          client_id: config.oidcClientID,
          redirect_uri: redirectUri,
          scope: "openid email profile",
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });

        const authUrl = `${config.oidcAuthorizationEndpoint}?${params}`;
        console.log("\nOpen this URL in your browser to log in:");
        console.log(`  ${authUrl}\n`);

        openBrowser(authUrl);
      })
      .catch(reject);

    setTimeout(() => {
      server.close();
      reject(new Error("Authorization timed out — no callback received within 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

  exec(cmd, () => {});
}
