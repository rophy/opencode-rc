import { describe, it, expect } from "vitest"
import { dropBogusContentLength } from "./fix-response"

function response(body: string | null, init: ResponseInit) {
  return new Response(body, init)
}

describe("dropBogusContentLength", () => {
  it("drops content-length: 0 when the body is not empty", async () => {
    const res = await dropBogusContentLength(
      response('[{"id":"global"}]', {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "0" },
      }),
    )
    expect(res.headers.get("content-length")).toBeNull()
    expect(res.headers.get("content-type")).toBe("application/json")
    expect(await res.json()).toEqual([{ id: "global" }])
  })

  it("keeps content-length: 0 when the body is really empty", async () => {
    const res = await dropBogusContentLength(
      response(null, { status: 200, headers: { "content-length": "0" } }),
    )
    expect(res.headers.get("content-length")).toBe("0")
    expect(await res.text()).toBe("")
  })

  it("returns responses without content-length: 0 untouched", async () => {
    const original = response("{}", { status: 200, headers: { "content-type": "application/json" } })
    expect(await dropBogusContentLength(original)).toBe(original)
  })

  it("does not buffer event streams", async () => {
    const original = response("data: {}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream", "content-length": "0" },
    })
    expect(await dropBogusContentLength(original)).toBe(original)
  })

  it("leaves error responses untouched", async () => {
    const original = response("oops", { status: 500, headers: { "content-length": "0" } })
    expect(await dropBogusContentLength(original)).toBe(original)
  })
})
