import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createOpencodeServer } from "@opencode-ai/sdk/server";

export interface LocalServer {
  /** Base URL of the local opencode server, e.g. http://127.0.0.1:41234 */
  url: string;
  /** Authorization header value to send on every forwarded request (2.x only). */
  authorization?: string;
  close(): void;
}

export interface StartV2Options {
  /** Command to run (default "opencode"); tests pass a fake. */
  command?: string;
  /** Arguments before "serve" (tests: the fixture path when command is "node"). */
  prefixArgs?: string[];
  /** Milliseconds to wait for the {"url"} line (default 60000). */
  timeoutMs?: number;
  /** Called if the server exits on its own after it started. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export async function startServer(major: 1 | 2, opts: StartV2Options = {}): Promise<LocalServer> {
  if (major === 2) return startServerV2(opts);
  console.log("Starting opencode serve...");
  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0,
  });
  console.log(`opencode serve running at ${server.url}`);
  return { url: server.url, close: () => server.close() };
}

function startServerV2(opts: StartV2Options): Promise<LocalServer> {
  const command = opts.command ?? "opencode";
  const timeoutMs = opts.timeoutMs ?? 60000;

  // The 2.x server is password protected (Basic auth, user "opencode"). A fresh random
  // password per run keeps other local processes from using the server; only this CLI
  // knows it. OPENCODE_PASSWORD wins over OPENCODE_SERVER_PASSWORD, which is removed so
  // a value from the user's environment cannot change which password is in effect.
  const password = randomBytes(32).toString("base64url");
  const authorization = "Basic " + Buffer.from("opencode:" + password).toString("base64");
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_PASSWORD: password };
  delete env.OPENCODE_SERVER_PASSWORD;

  console.log("Starting opencode serve...");
  // --port 0 picks a free port; --stdio makes the server print {"url"} once it listens and
  // shut down when our stdin closes, so it cannot outlive this process.
  const child = spawn(
    command,
    [...(opts.prefixArgs ?? []), "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      // The shell finds npm's opencode.cmd on Windows (as opencode-version.ts does).
      shell: process.platform === "win32" && command === "opencode",
    },
  );

  return new Promise<LocalServer>((resolve, reject) => {
    let started = false;
    let settled = false;
    let exited = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    const stderrTail: string[] = [];

    const terminate = () => {
      if (exited) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 3000).unref();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const timer = setTimeout(() => {
      terminate();
      fail(new Error(`opencode serve timed out after ${timeoutMs} ms without reporting its URL`));
    }, timeoutMs);

    const onStdoutLine = (line: string) => {
      if (!started) {
        try {
          const msg = JSON.parse(line);
          if (msg && typeof msg.url === "string") {
            started = true;
            settled = true;
            clearTimeout(timer);
            console.log(`opencode serve running at ${msg.url}`);
            resolve({
              url: msg.url,
              authorization,
              close() {
                child.stdin.end();
                setTimeout(() => {
                  if (!exited) child.kill("SIGTERM");
                }, 5000).unref();
              },
            });
            return;
          }
        } catch {
          // not the URL line
        }
      }
      console.error(line);
    };
    const onStderrLine = (line: string) => {
      stderrTail.push(line);
      if (stderrTail.length > 20) stderrTail.shift();
      console.error(line);
    };
    const splitLines = (chunk: Buffer, buf: string, onLine: (l: string) => void) => {
      const lines = (buf + chunk.toString()).split(/\r?\n/);
      const rest = lines.pop() ?? "";
      for (const l of lines) if (l) onLine(l);
      return rest;
    };

    child.stdout.on("data", (c: Buffer) => (stdoutBuf = splitLines(c, stdoutBuf, onStdoutLine)));
    child.stderr.on("data", (c: Buffer) => (stderrBuf = splitLines(c, stderrBuf, onStderrLine)));
    child.stdin.on("error", () => {}); // EPIPE when the child is already gone

    child.on("error", (err) => fail(new Error(`could not start ${command}: ${err.message}`)));
    child.on("close", (code, signal) => {
      exited = true;
      if (stdoutBuf) onStdoutLine(stdoutBuf);
      if (stderrBuf) onStderrLine(stderrBuf);
      if (started) {
        opts.onExit?.(code, signal);
      } else {
        const tail = stderrTail.join("\n");
        fail(
          new Error(
            `opencode serve exited (${signal ?? `code ${code}`}) before it was ready` +
              (tail ? `:\n${tail}` : ""),
          ),
        );
      }
    });
  });
}
