// cli/src/register.ts

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Config } from "./config.js";

export function generateSessionID(): string {
  return `${hostname()}-${randomUUID().slice(0, 8)}`;
}

export async function registerWithGateway(
  config: Config,
  idToken: string,
  sessionID: string,
  endpoint: string,
  directory: string
): Promise<void> {
  const res = await fetch(`${config.gatewayUrl}/gateway/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ sessionId: sessionID, endpoint, directory }),
  });

  if (!res.ok) {
    throw new Error(
      `Registration failed: ${res.status} ${await res.text()}`
    );
  }

  console.log(`Registered with gateway as session ${sessionID}`);
}

export function startHeartbeat(
  config: Config,
  idToken: string,
  sessionID: string
): () => void {
  const intervalMs = 15_000;
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`${config.gatewayUrl}/gateway/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ sessionId: sessionID }),
      });
      if (!res.ok) {
        console.error(`Heartbeat failed: ${res.status}`);
      }
    } catch (err) {
      console.error(`Heartbeat error: ${err}`);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

export async function deregisterFromGateway(
  config: Config,
  idToken: string,
  sessionID: string
): Promise<void> {
  try {
    await fetch(`${config.gatewayUrl}/gateway/deregister`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ sessionId: sessionID }),
    });
  } catch {
    // Best-effort on shutdown
  }
}
