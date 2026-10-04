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

  it("shows the server's reason as text", () => {
    render(() => <NoAccessScreen email="bob@example.com" reason="<b>not in the dev group</b>" onRetry={() => {}} />)
    expect(screen.getByText("<b>not in the dev group</b>")).toBeTruthy()
  })

  it("shows no reason line without a reason", () => {
    render(() => <NoAccessScreen email="bob@example.com" onRetry={() => {}} />)
    expect(screen.queryByText(/Reason/)).toBeNull()
  })
})
