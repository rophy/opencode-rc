// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const desktopNative = fileURLToPath(new URL("../../vendor/opencode-v1/packages/app/src/i18n/desktop-native.ts", import.meta.url))

describe.skipIf(!fs.existsSync(desktopNative))("Android locales_config.xml", async () => {
  const { DESKTOP_NATIVE_LOCALES, detectDesktopNativeLocale } = await import(
    "../../vendor/opencode-v1/packages/app/src/i18n/desktop-native"
  )
  const { LOCALES_CONFIG, androidTag, localesConfigXml } = await import("./locales-config")

  it("is up to date with opencode's languages (regenerate: bun build/locales-config.ts)", () => {
    expect(fs.readFileSync(LOCALES_CONFIG, "utf8")).toBe(localesConfigXml())
  })

  // The WebView reports only the language and region of the app's locale.
  const webview = (tag: string) => {
    const locale = new Intl.Locale(tag)
    return locale.region ? `${locale.language}-${locale.region}` : locale.language
  }

  it.each([...DESKTOP_NATIVE_LOCALES])("the tag for %s selects it in the UI", (code) => {
    expect(detectDesktopNativeLocale([webview(androidTag(code))])).toBe(code)
  })

  it("names locales the WebView would confuse by region, drops other regions", () => {
    expect(androidTag("zh")).toBe("zh-CN")
    expect(androidTag("zht")).toBe("zh-TW")
    expect(androidTag("pa")).toBe("pa-PK")
    expect(androidTag("br")).toBe("pt-BR")
    expect(androidTag("no")).toBe("nb")
    expect(androidTag("it")).toBe("it")
  })
})
