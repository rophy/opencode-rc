import { createOpencodeServer } from "@opencode-ai/sdk/server";

export async function startServer(): Promise<{ url: string; close(): void }> {
  console.log("Starting opencode serve...");
  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0,
  });
  console.log(`opencode serve running at ${server.url}`);
  return server;
}
