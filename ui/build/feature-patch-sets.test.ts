// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FEATURES } from "../../config/schema"
import { applyPatches, featurePatches, readPatches } from "./vendor-patches"

const opencode = fileURLToPath(new URL("../../vendor/opencode-v1", import.meta.url))
const patchesRoot = fileURLToPath(new URL("../../vendor/patches", import.meta.url))
const patched = (feature: string, file: string) =>
  applyPatches(fs.readFileSync(path.join(opencode, file), "utf8"), file, readPatches(path.join(patchesRoot, feature)))

describe.skipIf(!fs.existsSync(path.join(opencode, "packages/app")))("feature patches on the pinned opencode", () => {
  // A deployment can disable any set of features, so every combination must apply.
  it("applies for every combination of disabled features", () => {
    for (let mask = 0; mask < 1 << FEATURES.length; mask++) {
      const disabled = FEATURES.filter((_, i) => mask & (1 << i))
      const patches = featurePatches(patchesRoot, FEATURES, disabled)
      for (const file of new Set(patches.map((p) => p.file))) {
        expect(() => applyPatches(fs.readFileSync(path.join(opencode, file), "utf8"), file, patches), disabled.join(",")).not.toThrow()
      }
    }
  })

  it("shell: no shell mode in either composer, no + menu item", () => {
    const v1 = patched("shell", "packages/app/src/components/prompt-input.tsx")
    expect(v1).toContain('setStore("mode", "normal")')
    expect(v1).not.toContain('if (event.key === "!" && store.mode === "normal") {')
    expect(v1).toMatch(/keybind: shellModeKey,\n\s+disabled: true,\n\s+hidden: true,/)
    const v2 = patched("shell", "packages/app/src/components/prompt-input-v2.tsx")
    expect(v2).toMatch(/keybind: "mod\+shift\+x",\n\s+disabled: true,\n\s+hidden: true,/)
    const machine = patched("shell", "packages/session-ui/src/v2/components/prompt-input/machine.ts")
    expect(machine).toContain('if (event.type === "mode.shell") return changed({ ...state, mode: "normal"')
    expect(machine).not.toContain('value === "!"')
    const menu = patched("shell", "packages/session-ui/src/v2/components/prompt-input/index.tsx")
    expect(menu).not.toContain("onSelect={props.onShell}")
  })

  it("export: no export menu items, button or command", () => {
    const timeline = patched("export", "packages/app/src/pages/session/timeline/message-timeline.tsx")
    expect(timeline).not.toContain("onSelect={() => exportSession(id)}")
    const tab = patched("export", "packages/app/src/components/session/session-context-tab.tsx")
    expect(tab).not.toContain("onClick={exportSession}")
    const commands = patched("export", "packages/app/src/pages/session/use-session-commands.tsx")
    expect(commands).not.toContain('id: "session.export"')
  })

  it("share: the UI treats sharing as disabled", () => {
    const commands = patched("share", "packages/app/src/pages/session/use-session-commands.tsx")
    expect(commands).not.toContain('if (sync().data.config.share === "disabled") return []')
    const timeline = patched("share", "packages/app/src/pages/session/timeline/message-timeline.tsx")
    expect(timeline).toContain("const shareEnabled = createMemo(() => false)")
  })
})
