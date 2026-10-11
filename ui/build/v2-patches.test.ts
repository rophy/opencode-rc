// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FEATURES_V2 } from "../../config/schema"
import { applyPatches, featurePatches, readPatches } from "./vendor-patches"

const opencode = fileURLToPath(new URL("../../vendor/opencode-v2", import.meta.url))
const patchesRoot = fileURLToPath(new URL("../../vendor/patches/v2", import.meta.url))
const patched = (feature: string, file: string) =>
  applyPatches(fs.readFileSync(path.join(opencode, file), "utf8"), file, readPatches(path.join(patchesRoot, feature)))

describe("2.x feature patches on the pinned opencode", () => {
  // A deployment can disable any set of features, so every combination must apply.
  it("applies for every combination of disabled features", () => {
    for (let mask = 0; mask < 1 << FEATURES_V2.length; mask++) {
      const disabled = FEATURES_V2.filter((_, i) => mask & (1 << i))
      const patches = featurePatches(patchesRoot, FEATURES_V2, disabled)
      for (const file of new Set(patches.map((p) => p.file))) {
        expect(() => applyPatches(fs.readFileSync(path.join(opencode, file), "utf8"), file, patches), disabled.join(",")).not.toThrow()
      }
    }
  })

  it("uploads: no attachments config, no file.attach command, no attach menu item", () => {
    const model = patched("uploads", "packages/app/src/composer/model.ts")
    expect(model).not.toContain("attachments: {")
    expect(model).not.toContain('id: "file.attach"')
    const editor = patched("uploads", "packages/app/src/composer/editor/editor.tsx")
    expect(editor).not.toContain("onSelect={props.onAttach}")
  })

  it("uploads: a project icon file is never read and the picker never opens", () => {
    const code = patched("uploads", "packages/app/src/settings/workspaces/project-model.ts")
    expect(code).toMatch(/function selectFile\(file: File\) \{\n\s+return\n/)
    expect(code).not.toContain("iconInput?.click()")
  })

  it("shell: no shell mode, no ! trigger, no + menu item", () => {
    const machine = patched("shell", "packages/app/src/composer/suggestions/machine.ts")
    expect(machine).toContain('if (event.type === "mode.shell") return changed({ ...state, mode: "normal"')
    expect(machine).not.toContain('value === "!"')
    const model = patched("shell", "packages/app/src/composer/model.ts")
    expect(model).toMatch(/keybind: "mod\+shift\+x",\n\s+disabled: true,\n\s+hidden: true,/)
    const editor = patched("shell", "packages/app/src/composer/editor/editor.tsx")
    expect(editor).not.toContain("onSelect={props.onShell}")
  })

  it("export: no command, menu items or button", () => {
    const commands = patched("export", "packages/app/src/session/commands/use-session-commands.tsx")
    expect(commands).not.toContain('id: "session.export"')
    const timeline = patched("export", "packages/app/src/session/timeline/message-timeline.tsx")
    expect(timeline).not.toContain("props.action.export(id)")
    const home = patched("export", "packages/app/src/home/sessions/view.tsx")
    expect(home).not.toContain("props.onExportSession(")
    const tab = patched("export", "packages/gui-extensions/src/context/tab.tsx")
    expect(tab).not.toContain("onClick={exportSession}")
  })

  it("terminal: not among the built-in extensions", () => {
    const code = patched("terminal", "packages/gui-extensions/src/renderer.ts")
    expect(code).not.toMatch(/\bterminal\b/)
    expect(code).toContain("{ ...debug, renderer: eager(debugRenderer) }")
  })
})
