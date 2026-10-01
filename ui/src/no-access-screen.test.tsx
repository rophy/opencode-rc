import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@solidjs/testing-library"
import { NoAccessScreen } from "./no-access-screen"

afterEach(() => cleanup())

describe("NoAccessScreen", () => {
  it("names the signed-in account and retries on request", async () => {
    const onRetry = vi.fn()
    render(() => <NoAccessScreen email="bob@example.com" onRetry={onRetry} />)
    expect(screen.getByText("No access")).toBeTruthy()
    expect(screen.getByText(/signed in as bob@example\.com/)).toBeTruthy()
    await fireEvent.click(screen.getByText("Check again"))
    expect(onRetry).toHaveBeenCalled()
  })
})
