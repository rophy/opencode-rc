import { createRequire } from "node:module";

// package.json is one level up from both src/ (tsx) and dist/ (installed), and npm always packs it.
export const CLI_VERSION: string = createRequire(import.meta.url)("../package.json").version;

export function wantsVersion(args: string[]): boolean {
  return args.includes("--version") || args.includes("-v");
}
