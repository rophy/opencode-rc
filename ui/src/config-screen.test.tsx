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
    expect(screen.getByPlaceholderText("http://localhost:3000")).toBeTruthy()
    expect(screen.getByText("Save")).toBeTruthy()
  })

  it("shows error for empty URL", async () => {
    const onSave = vi.fn()
    render(() => <ConfigScreen onSave={onSave} />)
    await fireEvent.click(screen.getByText("Save"))
    expect(screen.getByText("Enter a server URL")).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("shows error for invalid URL", async () => {
    const onSave = vi.fn()
    render(() => <ConfigScreen onSave={onSave} />)
    const input = screen.getByPlaceholderText("http://localhost:3000") as HTMLInputElement
    await fireEvent.input(input, { target: { value: "not-a-url" } })
    await fireEvent.click(screen.getByText("Save"))
    expect(screen.getByText("Invalid URL")).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("shows error when server is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"))
    const onSave = vi.fn()
    render(() => <ConfigScreen onSave={onSave} />)
    const input = screen.getByPlaceholderText("http://localhost:3000") as HTMLInputElement
    await fireEvent.input(input, { target: { value: "https://example.com" } })
    await fireEvent.click(screen.getByText("Save"))
    await vi.waitFor(() => {
      expect(screen.getByText(/Cannot reach server/)).toBeTruthy()
    })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("saves URL and calls onSave when server is reachable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", protocol: 1 }), { status: 200 }),
    )
    const onSave = vi.fn()
    render(() => <ConfigScreen onSave={onSave} />)
    const input = screen.getByPlaceholderText("http://localhost:3000") as HTMLInputElement
    await fireEvent.input(input, { target: { value: "https://rc.example.com" } })
    await fireEvent.click(screen.getByText("Save"))
    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce()
    })
    expect(getBaseUrl()).toBe("https://rc.example.com")
  })

  it("shows error when server's protocol is too old", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    )
    const onSave = vi.fn()
    render(() => <ConfigScreen onSave={onSave} />)
    const input = screen.getByPlaceholderText("http://localhost:3000") as HTMLInputElement
    await fireEvent.input(input, { target: { value: "https://rc.example.com" } })
    await fireEvent.click(screen.getByText("Save"))
    await vi.waitFor(() => {
      expect(screen.getByText("This is not an OpenCode RC server, or it is older than this app supports.")).toBeTruthy()
    })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("shows cancel button when onCancel provided", async () => {
    const onCancel = vi.fn()
    render(() => <ConfigScreen onSave={vi.fn()} onCancel={onCancel} />)
    expect(screen.getByText("Cancel")).toBeTruthy()
    await fireEvent.click(screen.getByText("Cancel"))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("hides cancel button when onCancel not provided", () => {
    render(() => <ConfigScreen onSave={vi.fn()} />)
    expect(screen.queryByText("Cancel")).toBeNull()
  })

  it("pre-fills with existing base URL", () => {
    localStorage.setItem("opencode-rc-endpoint", "https://existing.example.com")
    const onSave = vi.fn()
    render(() => <ConfigScreen onSave={onSave} />)
    const input = screen.getByPlaceholderText("http://localhost:3000") as HTMLInputElement
    expect(input.value).toBe("https://existing.example.com")
  })
})
