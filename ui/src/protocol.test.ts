import { describe, it, expect, beforeEach } from "vitest"
import {
  MIN_SERVER_PROTOCOL, PROTOCOL, PROTOCOL_HEADER, checkProtocol, protocolState, readProtocol,
  resetProtocolState, withProtocol,
} from "./protocol"

const res = (status: number, headers: Record<string, string> = {}, body = "{}") =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } })

beforeEach(() => resetProtocolState())

describe("protocol", () => {
  it("starts at protocol 1", () => {
    expect(PROTOCOL).toBe(1)
    expect(MIN_SERVER_PROTOCOL).toBe(1)
  })

  it("reads integers and treats anything else as 0", () => {
    expect(readProtocol("2")).toBe(2)
    for (const v of [null, undefined, "", "x", "-1", "1.5"]) expect(readProtocol(v)).toBe(0)
  })

  it("adds the header without dropping others", () => {
    const h = new Headers(withProtocol({ headers: { a: "b" } }).headers)
    expect(h.get(PROTOCOL_HEADER)).toBe("1")
    expect(h.get("a")).toBe("b")
  })

  it("stays ok for a current server", async () => {
    await checkProtocol(res(200, { [PROTOCOL_HEADER]: "1" }))
    expect(protocolState()).toBe("ok")
  })

  it("flags an outdated client on 426 client_outdated", async () => {
    await checkProtocol(res(426, { [PROTOCOL_HEADER]: "2" }, JSON.stringify({ error: "client_outdated" })))
    expect(protocolState()).toBe("client_outdated")
  })

  it("flags an outdated server when the header is missing or too low", async () => {
    await checkProtocol(res(200))
    expect(protocolState()).toBe("server_outdated")
    resetProtocolState()
    await checkProtocol(res(200, { [PROTOCOL_HEADER]: "0" }))
    expect(protocolState()).toBe("server_outdated")
  })

  it("leaves state ok for a header-less 5xx (proxy/ingress error during a restart, not an outdated server)", async () => {
    await checkProtocol(res(502))
    expect(protocolState()).toBe("ok")
  })

  it("does not consume the caller's body", async () => {
    const r = res(426, { [PROTOCOL_HEADER]: "2" }, JSON.stringify({ error: "client_outdated" }))
    await checkProtocol(r)
    expect(await r.json()).toEqual({ error: "client_outdated" })
  })
})
