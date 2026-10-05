// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyPatches, readPatches } from "./vendor-patches"

const opencode = fileURLToPath(new URL("../../vendor/opencode", import.meta.url))
const patchDir = fileURLToPath(new URL("../../vendor/patches/terminal", import.meta.url))
const patched = (file: string) => applyPatches(fs.readFileSync(path.join(opencode, file), "utf8"), file, readPatches(patchDir))

describe.skipIf(!fs.existsSync(path.join(opencode, "packages/app")))("terminal patches on the pinned opencode", () => {
  it("the terminal view never opens, so neither terminal panel renders", () => {
    const code = patched("packages/app/src/context/layout.tsx")
    expect(code).toContain("terminal: {\n            opened: () => false,\n            open() {},")
    expect(code).not.toContain("setTerminalOpened(true)")
  })

  it("the terminal commands are gone (ctrl+`, /terminal, new terminal)", () => {
    const code = patched("packages/app/src/pages/session/use-session-commands.tsx")
    expect(code).not.toContain('id: "terminal.toggle"')
    expect(code).not.toContain('id: "terminal.new"')
    expect(code).not.toContain('slash: "terminal"')
  })

  it("the session header has no terminal button", () => {
    const code = patched("packages/app/src/components/session/session-header.tsx")
    expect(code).not.toContain("group/terminal-toggle")
  })
})
