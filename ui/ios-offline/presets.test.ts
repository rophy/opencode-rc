// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { FEATURES, FEATURES_V2, parseConfig } from "../../config/schema.ts"

const preset = (name: string) =>
  JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../../config/presets/${name}.json`, import.meta.url)), "utf8"))

describe("iOS offline bundle presets", () => {
  it("all-off validates, uses the placeholder server and disables every feature", () => {
    const config = parseConfig(preset("all-off"), "all-off.json")
    expect(config.serverUrl).toBe("https://rc-placeholder.invalid")
    for (const name of FEATURES) expect(config.features[name].enabled, `features.${name}`).toBe(false)
    for (const name of FEATURES_V2) expect(config.opencodeV2.features[name].enabled, `opencodeV2.features.${name}`).toBe(false)
  })
})
