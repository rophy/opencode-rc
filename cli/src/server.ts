import { createOpencodeServer } from "@opencode-ai/sdk/server";

export async function startServer(): Promise<{ url: string; close(): void }> {
  const server = await createOpencodeServer({
    hostname: "0.0.0.0",
    port: 4096,
  });
  console.log(`opencode serve running at ${server.url}`);
  return server;
}
