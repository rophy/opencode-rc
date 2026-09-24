import { describe, it, expect } from "vitest"
import { sha256Sync } from "./sha256"

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const text = (s: string) => new TextEncoder().encode(s)

describe("sha256Sync", () => {
  it("matches the FIPS 180-2 vectors", () => {
    expect(hex(sha256Sync(text("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(hex(sha256Sync(text("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(hex(sha256Sync(text("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    )
  })

  it("matches crypto.subtle across block boundaries", async () => {
    for (const n of [55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = crypto.getRandomValues(new Uint8Array(n))
      const want = new Uint8Array(await crypto.subtle.digest("SHA-256", data))
      expect(hex(sha256Sync(data))).toBe(hex(want))
    }
  })
})
