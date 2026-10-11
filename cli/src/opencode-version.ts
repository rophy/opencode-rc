import { execFileSync } from "node:child_process";

// `opencode --version` prints "1.18.29" on 1.x and "opencode v2.0.26" on 2.x.
export function parseOpencodeVersion(output: string): string | null {
  const m = output.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

const runOpencodeVersion = () =>
  execFileSync("opencode", ["--version"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });

export function detectOpencodeVersion(run: () => string = runOpencodeVersion): string {
  let output: string;
  try {
    output = run();
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error("opencode is not installed or not on PATH. Install opencode first.");
    throw new Error(`could not run "opencode --version": ${err?.message ?? err}`);
  }
  const version = parseOpencodeVersion(output);
  if (!version) throw new Error(`could not read the opencode version from "opencode --version": ${output.trim()}`);
  return version;
}
