import { createOpencodeServer } from "@opencode-ai/sdk/server";

export async function startServer(port: number): Promise<{ url: string; close(): void }> {
  console.log(`Starting opencode serve on 0.0.0.0:${port}...`);
  const server = await createOpencodeServer({
    hostname: "0.0.0.0",
    port,
  });
  console.log(`opencode serve running at ${server.url}`);
  return server;
}
