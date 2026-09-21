import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@solidjs/testing-library"
import { ConfigScreen } from "./config-screen"
import { getBaseUrl } from "./api"

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("ConfigScreen", () => {
  it("renders the form", () => {
    const onSave = vi.fn()
    render(() => <ConfigScreen onSave={onSave} />)
    expect(screen.getByText("Connect to Server")).toBeTruthy()
    expect(screen.getByPlaceholderText("https://opencode-rc.example.com")).toBeTruthy()
    expect(screen.getByText("Connect")).toBeTruthy()
  })

  it("shows error for empty URL", async () => {
    const onSave = vi.fn()
    render(() => <ConfigScreen onSave={onSave} />)
    await fireEvent.click(screen.getByText("Connect"))
    expect(screen.getByText("Enter a server URL")).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("shows error for invalid URL", async () => {
    const onSave = vi.fn()
    render(() => <ConfigScreen onSave={onSave} />)
    const input = screen.getByPlaceholderText("https://opencode-rc.example.com") as HTMLInputElement
    await fireEvent.input(input, { target: { value: "not-a-url" } })
    await fireEvent.click(screen.getByText("Connect"))
    expect(screen.getByText("Invalid URL")).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("shows error when server is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"))
    const onSave = vi.fn()
    render(() => <ConfigScreen onSave={onSave} />)
    const input = screen.getByPlaceholderText("https://opencode-rc.example.com") as HTMLInputElement
    await fireEvent.input(input, { target: { value: "https://example.com" } })
    await fireEvent.click(screen.getByText("Connect"))
    await vi.waitFor(() => {
      expect(screen.getByText(/Cannot reach server/)).toBeTruthy()
    })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("saves URL and calls onSave when server is reachable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }))
    const onSave = vi.fn()
    render(() => <ConfigScreen onSave={onSave} />)
    const input = screen.getByPlaceholderText("https://opencode-rc.example.com") as HTMLInputElement
    await fireEvent.input(input, { target: { value: "https://rc.example.com" } })
    await fireEvent.click(screen.getByText("Connect"))
    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce()
    })
    expect(getBaseUrl()).toBe("https://rc.example.com")
  })

  it("pre-fills with existing base URL", () => {
    localStorage.setItem("opencode-rc-endpoint", "https://existing.example.com")
    const onSave = vi.fn()
    render(() => <ConfigScreen onSave={onSave} />)
    const input = screen.getByPlaceholderText("https://opencode-rc.example.com") as HTMLInputElement
    expect(input.value).toBe("https://existing.example.com")
  })
})
