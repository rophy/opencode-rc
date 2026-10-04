import { describe, it, expect, vi } from "vitest"

vi.mock("./build-config", () => ({
  buildConfig: { serverUrl: "https://corp.example.com", features: { uploads: { enabled: true } } },
}))

describe("server preset from the build config", () => {
  it("uses the compiled-in serverUrl over localStorage", async () => {
    localStorage.setItem("opencode-rc-endpoint", "https://user-set.example.com")
    const { getBaseUrl, isPreConfigured } = await import("./server")
    expect(isPreConfigured()).toBe(true)
    expect(getBaseUrl()).toBe("https://corp.example.com")
  })
})
