// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FEATURES } from "../../config/schema"
import { applyPatches, featurePatches } from "./vendor-patches"

const opencode = fileURLToPath(new URL("../../vendor/opencode-v1", import.meta.url))
const patchesRoot = fileURLToPath(new URL("../../vendor/patches/v1", import.meta.url))
// The patches a build with only config disabled applies, shared ones (config+shell) included.
const patched = (file: string) =>
  applyPatches(fs.readFileSync(path.join(opencode, file), "utf8"), file, featurePatches(patchesRoot, FEATURES, ["config"]))
const upstream = (file: string) => fs.readFileSync(path.join(opencode, file), "utf8")

const components = "packages/app/src/components"

// The API refuses config writes while config is disabled (api/src/config-guard.ts), so the UI must
// not offer them.
describe.skipIf(!fs.existsSync(path.join(opencode, "packages/app")))("config patches on the pinned opencode", () => {
  it("the provider settings have no custom provider entry", () => {
    for (const file of ["settings-providers.tsx", "settings-v2/providers.tsx"]) {
      const code = patched(`${components}/${file}`)
      expect(code, file).not.toContain('data-component="custom-provider-section"')
      expect(code, file).not.toContain("DialogCustomProvider")
      // Signing in to a provider stays.
      expect(code, file).toContain("onClick={() => connect(item.id)}")
      expect(code, file).toContain("onClick={() => connect()}")
    }
  })

  it("the connect dialog lists no custom provider and cannot show its form", () => {
    const code = patched(`${components}/dialog-connect-provider.tsx`)
    expect(code).not.toContain("CustomProviderForm")
    expect(code).not.toContain("{ id: CUSTOM_ID, name:")
    expect(code).toContain("return [...providers.all().values()]")
    expect(code).toContain("const values = [...providers.all().values()]")
    // Signing in with an API key or OAuth stays.
    expect(code).toContain("<ProviderConnection")
  })

  // Disconnecting a provider from the deployment's config writes disabled_providers.
  it("providers from the config cannot be disconnected", () => {
    for (const file of ["settings-providers.tsx", "settings-v2/providers.tsx"]) {
      const code = patched(`${components}/${file}`)
      expect(code, file).toContain('source(item) !== "env" && !isConfigCustom(item.id)')
      expect(upstream(`${components}/${file}`), file).toContain('(protocol() === "v1" || !isConfigCustom(item.id))')
    }
  })

  it("no other provider code writes the config", () => {
    // The only config writes in the app: the custom provider dialog (unreachable above), the
    // disabled_providers update (unreachable above) and the shell setting (removed below).
    const writers = ["dialog-custom-provider.tsx", "settings-providers.tsx", "settings-v2/providers.tsx", "settings-general.tsx", "settings-v2/general-controllers.ts"]
    const app = path.join(opencode, "packages/app/src")
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") && fs.readFileSync(full, "utf8").includes("updateConfig(")) {
          found.push(path.relative(path.join(app, "components"), full))
        }
      }
    }
    walk(app)
    expect(found.sort()).toEqual(writers.sort())
  })

  it("no terminal shell setting, no project start command, edits send no commands", () => {
    const general = patched(`${components}/settings-general.tsx`)
    expect(general).not.toContain('data-action="settings-shell"')
    expect(general).not.toContain("updateConfig({ shell:")
    expect(patched(`${components}/settings-v2/general.tsx`)).not.toContain("<ShellSetting controller={shell} />")
    const model = patched(`${components}/edit-project.ts`)
    expect(model).not.toMatch(/^\s+commands: \{ start \},$/m)
    expect(model).toContain('icon: { color: store.color || "", override: store.iconOverride || "" },\n          })')
    for (const file of ["dialog-edit-project.tsx", "dialog-edit-project-v2.tsx"]) {
      const dialog = patched(`${components}/${file}`)
      expect(dialog, file).not.toContain("dialog.project.edit.worktree.startup")
      expect(dialog, file).toContain("dialog.project.edit.name")
    }
  })

  it("model choice is untouched", () => {
    const files = featurePatches(patchesRoot, FEATURES, ["config"]).map((p) => p.file)
    expect(files.some((file) => /model/i.test(file))).toBe(false)
  })
})
