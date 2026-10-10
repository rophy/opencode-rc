// Type-checks ui/src against opencode's real types: tsconfig maps @opencode-ai/app to the
// submodule's source (installed with `cd vendor/opencode && bun install`), so tsc also checks
// the opencode files we import. Their errors are opencode's (it type-checks them with its own
// setup); only errors in our files fail.
//   bun build/typecheck.ts
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ui = fileURLToPath(new URL("..", import.meta.url))
const tsc = spawnSync("bunx", ["tsc", "--noEmit", "-p", "tsconfig.json", "--pretty", "false"], {
  cwd: ui,
  encoding: "utf8",
})
const errors = tsc.stdout.split("\n").filter((line) => /^(src|build)\/.*error TS/.test(line))
const vendor = tsc.stdout.split("\n").filter((line) => line.startsWith("../vendor/") && line.includes("error TS"))
if (tsc.status !== 0 && errors.length === 0 && vendor.length === 0) {
  console.error(tsc.stdout || tsc.stderr)
  process.exit(1)
}
for (const line of errors) console.error(line)
console.log(`typecheck: ${errors.length} error(s) in ui, ${vendor.length} in vendor/opencode (ignored)`)
process.exit(errors.length ? 1 : 0)
