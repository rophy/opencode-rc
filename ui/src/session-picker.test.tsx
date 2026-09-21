import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@solidjs/testing-library"
import { SessionPicker } from "./session-picker"

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const user = { sub: "alice", email: "alice@example.com", name: "Alice" }

describe("SessionPicker", () => {
  it("shows loading state", () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}))
    render(() => <SessionPicker user={user} />)
    expect(screen.getByText("Loading sessions...")).toBeTruthy()
  })

  it("shows empty state when no sessions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })
    )
    render(() => <SessionPicker user={user} />)
    await vi.waitFor(() => {
      expect(screen.getByText("No active sessions")).toBeTruthy()
    })
  })

  it("renders session cards", async () => {
    const sessions = [
      { id: "alice-dev", userID: "alice", endpoint: "gw:9090", directory: "/home/alice/project", lastHeartbeat: new Date().toISOString() },
    ]
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(sessions), { status: 200, headers: { "content-type": "application/json" } })
    )
    render(() => <SessionPicker user={user} />)
    await vi.waitFor(() => {
      expect(screen.getByText("project")).toBeTruthy()
    })
    expect(screen.getByText("/home/alice/project")).toBeTruthy()
    expect(screen.getByText("alice-de")).toBeTruthy()
  })

  it("session card links to correct URL", async () => {
    const sessions = [
      { id: "my-session", userID: "alice", endpoint: "gw:9090", directory: "/proj", lastHeartbeat: new Date().toISOString() },
    ]
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(sessions), { status: 200, headers: { "content-type": "application/json" } })
    )
    render(() => <SessionPicker user={user} />)
    await vi.waitFor(() => {
      expect(screen.getByText("proj")).toBeTruthy()
    })
    const link = screen.getByText("proj").closest("a")
    expect(link?.getAttribute("href")).toBe("/s/my-session/")
  })

  it("session card links include base URL when configured", async () => {
    localStorage.setItem("opencode-rc-endpoint", "https://rc.example.com")
    const sessions = [
      { id: "s1", userID: "alice", endpoint: "gw:9090", directory: "/proj", lastHeartbeat: new Date().toISOString() },
    ]
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(sessions), { status: 200, headers: { "content-type": "application/json" } })
    )
    render(() => <SessionPicker user={user} />)
    await vi.waitFor(() => {
      expect(screen.getByText("proj")).toBeTruthy()
    })
    const link = screen.getByText("proj").closest("a")
    expect(link?.getAttribute("href")).toBe("https://rc.example.com/s/s1/")
  })

  it("refresh button triggers refetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }))
    )
    render(() => <SessionPicker user={user} />)
    await vi.waitFor(() => {
      expect(screen.getByText("No active sessions")).toBeTruthy()
    })
    const refreshBtn = screen.getByTitle("Refresh")
    await (await import("@solidjs/testing-library")).fireEvent.click(refreshBtn)
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })
  })
})
