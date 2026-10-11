// Type-checks ui/src against opencode's real types: tsconfig maps @opencode-ai/app to the
// 1.x submodule's source (installed with `cd vendor/opencode-v1 && bun install`; tsconfig.v2.json
// does the same for @opencode/app and vendor/opencode-v2), so tsc also checks
// the opencode files we import. Their errors are opencode's (it type-checks them with its own
// setup); only errors in our files fail.
//   bun build/typecheck.ts
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ui = fileURLToPath(new URL("..", import.meta.url))
let failed = false
for (const [project, vendorDir] of [
  ["tsconfig.json", "vendor/opencode-v1"],
  ["tsconfig.v2.json", "vendor/opencode-v2"],
] as const) {
  const tsc = spawnSync("bunx", ["tsc", "--noEmit", "-p", project, "--pretty", "false"], { cwd: ui, encoding: "utf8" })
  const errors = tsc.stdout.split("\n").filter((line) => /^(src|build)\/.*error TS/.test(line))
  const vendor = tsc.stdout.split("\n").filter((line) => line.startsWith("../vendor/") && line.includes("error TS"))
  if (tsc.status !== 0 && errors.length === 0 && vendor.length === 0) {
    console.error(tsc.stdout || tsc.stderr)
    process.exit(1)
  }
  for (const line of errors) console.error(line)
  console.log(`typecheck (${project}): ${errors.length} error(s) in ui, ${vendor.length} in ${vendorDir} (ignored)`)
  if (errors.length) failed = true
}
process.exit(failed ? 1 : 0)
