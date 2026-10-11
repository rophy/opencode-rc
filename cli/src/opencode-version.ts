import { execFileSync } from "node:child_process";

// `opencode --version` prints "1.18.29" on 1.x and "opencode v2.0.26" on 2.x.
export function parseOpencodeVersion(output: string): string | null {
  const m = output.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export type OpencodeCheck =
  | { kind: "supported"; version: string }
  | { kind: "needs-newer-cli"; version: string }
  | { kind: "unsupported"; version: string }
  | { kind: "unknown" };

// Major 1 is supported; 2 needs a newer opencode-rc; 3+ is unsupported. No MAJOR.MINOR.PATCH
// (a source build printing "local") or major 0 (a snapshot "0.0.0-...") is not a release: unknown.
export function classifyOpencodeVersion(output: string): OpencodeCheck {
  const version = parseOpencodeVersion(output);
  if (!version) return { kind: "unknown" };
  const major = Number(version.split(".")[0]);
  if (major === 0) return { kind: "unknown" };
  if (major === 1) return { kind: "supported", version };
  if (major === 2) return { kind: "needs-newer-cli", version };
  return { kind: "unsupported", version };
}

const runOpencodeVersion = () =>
  execFileSync("opencode", ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    // npm installs opencode as opencode.cmd on Windows, which only a shell can launch. The args are fixed.
    shell: process.platform === "win32",
  });

// Returns the raw `opencode --version` output; throws when opencode is missing or fails to run.
export function detectOpencodeVersion(run: () => string = runOpencodeVersion): string {
  try {
    return run();
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error("opencode is not installed or not on PATH. Install opencode first.");
    throw new Error(`could not run "opencode --version": ${err?.message ?? err}`);
  }
}
