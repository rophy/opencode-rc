// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FEATURES, FEATURES_V2 } from "../../config/schema"
import { applyPatches, featurePatches } from "./vendor-patches"

const v1 = fileURLToPath(new URL("../../vendor/opencode-v1", import.meta.url))
const v2 = fileURLToPath(new URL("../../vendor/opencode-v2", import.meta.url))
const v1Patches = fileURLToPath(new URL("../../vendor/patches/v1", import.meta.url))
const v2Patches = fileURLToPath(new URL("../../vendor/patches/v2", import.meta.url))

const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), "utf8")
const patchedV1 = (file: string) => applyPatches(read(v1, file), file, featurePatches(v1Patches, FEATURES, ["mcp"]))
const patchedV2 = (file: string) => applyPatches(read(v2, file), file, featurePatches(v2Patches, FEATURES_V2, ["mcp"]))

// The app's source files (tests and stories excluded) that contain needle, relative to src.
function filesWith(src: string, needle: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|stories)\./.test(entry.name) && fs.readFileSync(full, "utf8").includes(needle)) {
        found.push(path.relative(src, full))
      }
    }
  }
  walk(src)
  return found.sort()
}

// The API refuses MCP connect, disconnect and sign-in while mcp is disabled (feature-guards.ts,
// v2-guard.ts), so the UI must not offer them. Server names and statuses stay visible.
describe.skipIf(!fs.existsSync(path.join(v1, "packages/app")))("1.x mcp patches on the pinned opencode", () => {
  const components = "packages/app/src/components"

  it("the MCP dialog lists servers without a switch and selecting one does nothing", () => {
    const code = patchedV1(`${components}/dialog-select-mcp.tsx`)
    expect(code).not.toContain("<Switch")
    expect(code).not.toContain("useMcpToggle")
    expect(code).toContain("onSelect={() => {}}")
    expect(code).toContain("<span class=\"truncate\">{i.name}</span>")
  })

  it("the status popover lists MCP servers without a switch, a button or the sign-in hint", () => {
    const code = patchedV1(`${components}/status-popover-body.tsx`)
    expect(code).not.toContain("toggleMcp")
    expect(code).not.toContain("<Switch")
    expect(code).not.toContain("mcp.auth.clickToAuthenticate")
    expect(code).toContain("{name}</span>")
  })

  it("only the patched components toggle MCP servers", () => {
    const src = path.join(v1, "packages/app/src")
    expect(filesWith(src, "useMcpToggle(")).toEqual(["components/dialog-select-mcp.tsx", "components/status-popover-body.tsx", "context/mcp.ts"])
    expect(filesWith(src, "mcp.auth.authenticate(")).toEqual(["context/server-sync.tsx"])
  })
})

describe.skipIf(!fs.existsSync(path.join(v2, "packages/app")))("2.x mcp patches on the pinned opencode", () => {
  const app = "packages/app/src"

  const plugins = "packages/gui-plugins/src"

  // Every MCP connect, disconnect and sign-in is a toggle request to an MCP machine, which runs it
  // as a run-toggle effect: the app's (providers/connect/mcp.tsx) and the session sidebar's
  // (gui-plugins details/server-panel.tsx).
  it("the MCP machines ignore toggle requests", () => {
    for (const file of [`${app}/providers/connect/mcp-machine.ts`, `${plugins}/details/mcp-machine.ts`]) {
      const machine = patchedV2(file)
      expect(machine).toContain('if (event.type === "toggle.requested") return { state, effects: NONE }')
      expect(machine).not.toContain('{ type: "run-toggle", name')
    }
    const src = path.join(v2, app)
    expect(filesWith(src, '"run-toggle"')).toEqual(["providers/connect/mcp-machine.ts", "providers/connect/mcp.tsx"])
    expect(filesWith(src, "mcp.connect(")).toEqual(["providers/connect/mcp.tsx"])
    const pluginSrc = path.join(v2, plugins)
    expect(filesWith(pluginSrc, '"run-toggle"')).toEqual(["details/mcp-machine.ts", "details/server-panel.tsx"])
    expect(filesWith(pluginSrc, "mcp.connect(")).toEqual(["details/server-panel.tsx"])
  })

  it("the session sidebar lists MCP servers without a switch, sign-in, disable or retry", () => {
    const code = patchedV2(`${plugins}/details/server-panel.tsx`)
    expect(code).not.toContain("<Switch")
    expect(code).not.toContain('class="session-mcp-sign-in"')
    expect(code).not.toContain('"mcp.error.disable"')
    expect(code).not.toContain("onClick={() => toggle(")
  })

  it("the MCP dialog lists servers without a switch, sign-in, disable or retry", () => {
    const code = patchedV2(`${app}/providers/connect/mcp-dialog.tsx`)
    expect(code).not.toContain("<Switch")
    expect(code).not.toContain('type: "toggle.requested"')
    expect(code).not.toContain("dialog.mcp.signIn.open")
    expect(code).not.toContain("dialog.mcp.error.disable")
    expect(code).toContain("const toggle = (_name: string, _enabled: boolean) => {}")
  })

  it("the extension settings list MCP servers without a switch or sign-in", () => {
    const global = patchedV2(`${app}/settings/providers/extensions.tsx`)
    expect(global).not.toContain("toggle(item, enabled)")
    expect(global).not.toContain("toggle(item, true)")
    const project = patchedV2(`${app}/settings/workspaces/project-extensions.tsx`)
    expect(project).not.toContain('type: "toggle.requested"')
    expect(project).not.toContain("<Switch")
  })

  // opencode registers each remote OAuth MCP server as an integration with metadata
  // { source: "mcp" } (core/src/mcp/index.ts register). The provider picker leaves them out
  // upstream, so no patch is needed.
  it("the Connect provider picker leaves out MCP integrations", () => {
    expect(read(v2, `${app}/providers/connect/dialog.tsx`)).toContain('.filter((row) => row.metadata?.source !== "mcp")')
    // The other callers look integrations up by id, keep only featured providers or count connections.
    expect(filesWith(path.join(v2, app), "useIntegrations(")).toEqual([
      "providers/catalog/integrations.ts",
      "providers/catalog/providers.ts",
      "providers/connect/controller.ts",
      "providers/connect/dialog.tsx",
      "providers/models/unpaid.tsx",
      "settings/providers/account-actions.ts",
      "settings/providers/providers.tsx",
    ])
  })
})
