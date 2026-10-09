import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { accessRecheck } from "./access-recheck"

const alice = { sub: "alice", email: "alice@example.com", name: "Alice" }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("accessRecheck", () => {
  it("applies a denial", async () => {
    const apply = vi.fn()
    const denied = { ...alice, allowed: false, reason: "left the office" }
    accessRecheck(async () => denied, apply)()
    await vi.runAllTimersAsync()
    expect(apply).toHaveBeenCalledExactlyOnceWith(denied)
  })

  it("applies a sign-out", async () => {
    const apply = vi.fn()
    accessRecheck(async () => null, apply)()
    await vi.runAllTimersAsync()
    expect(apply).toHaveBeenCalledExactlyOnceWith(null)
  })

  it("leaves the page when the user is still allowed or the check fails", async () => {
    const apply = vi.fn()
    accessRecheck(async () => ({ ...alice, allowed: true }), apply)()
    accessRecheck(async () => alice, apply)()
    accessRecheck(async () => Promise.reject(new Error("offline")), apply)()
    await vi.runAllTimersAsync()
    expect(apply).not.toHaveBeenCalled()
  })

  it("asks at most once per interval", async () => {
    const fetchMe = vi.fn(async () => alice)
    const check = accessRecheck(fetchMe, () => {}, 5000)
    check()
    check()
    vi.advanceTimersByTime(4999)
    check()
    expect(fetchMe).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    check()
    expect(fetchMe).toHaveBeenCalledTimes(2)
  })
})
