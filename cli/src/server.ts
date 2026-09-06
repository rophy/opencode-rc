// cli/src/server.ts

import { spawn } from "node:child_process";

export async function startServer(
  gatewayOrigin: string
): Promise<{ url: string; close(): void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "opencode",
      ["serve", "--hostname", "0.0.0.0", "--port", "4096", "--cors", gatewayOrigin],
      { stdio: ["ignore", "pipe", "inherit"] }
    );

    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/listening on (http:\/\/\S+)/);
      if (match) {
        console.log(`opencode serve running at ${match[1]}`);
        resolve({
          url: match[1],
          close: () => child.kill(),
        });
      }
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`opencode serve exited with code ${code}`));
      }
    });

    setTimeout(() => reject(new Error("opencode serve did not start within 10s")), 10000);
  });
}
