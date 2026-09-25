import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@solidjs/testing-library"
import { LoginScreen } from "./login-screen"
import { loadConfig, resetConfig } from "./api"
import * as auth from "./auth"

beforeEach(() => {
  localStorage.clear()
  resetConfig()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("LoginScreen", () => {
  it("renders login and settings buttons", () => {
    render(() => <LoginScreen onSettings={vi.fn()} />)
    expect(screen.getByText("Sign in with OIDC")).toBeTruthy()
    expect(screen.getByText("Server settings")).toBeTruthy()
  })

  it("calls onSettings when Server settings is clicked", async () => {
    const onSettings = vi.fn()
    render(() => <LoginScreen onSettings={onSettings} />)
    await fireEvent.click(screen.getByText("Server settings"))
    expect(onSettings).toHaveBeenCalledOnce()
  })

  it("redirects to /auth/start when no base URL", async () => {
    render(() => <LoginScreen onSettings={vi.fn()} />)
    const orig = window.location.href
    Object.defineProperty(window, "location", {
      value: { ...window.location, href: orig },
      writable: true,
    })
    await fireEvent.click(screen.getByText("Sign in with OIDC"))
    await vi.waitFor(() => expect(window.location.href.startsWith("/auth/start?return_to=")).toBe(true))
    expect(window.location.href).toMatch(/&code_challenge=[A-Za-z0-9_-]{43}$/)
  })

  it("redirects to base URL /auth/start when configured", async () => {
    localStorage.setItem("opencode-rc-endpoint", "https://rc.example.com")
    render(() => <LoginScreen onSettings={vi.fn()} />)
    Object.defineProperty(window, "location", {
      value: { ...window.location, href: "" },
      writable: true,
    })
    await fireEvent.click(screen.getByText("Sign in with OIDC"))
    await vi.waitFor(() =>
      expect(window.location.href.startsWith("https://rc.example.com/auth/start?return_to=")).toBe(true),
    )
  })

  it("hides Server settings when pre-configured", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ serverUrl: "https://corp.example.com" }), { status: 200 })
    )
    await loadConfig()
    render(() => <LoginScreen onSettings={vi.fn()} />)
    expect(screen.queryByText("Server settings")).toBeNull()
    expect(screen.getByText("Sign in with OIDC")).toBeTruthy()
  })

  it("uses pre-configured URL for login redirect", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ serverUrl: "https://corp.example.com" }), { status: 200 })
    )
    await loadConfig()
    render(() => <LoginScreen onSettings={vi.fn()} />)
    Object.defineProperty(window, "location", {
      value: { ...window.location, href: "" },
      writable: true,
    })
    await fireEvent.click(screen.getByText("Sign in with OIDC"))
    await vi.waitFor(() =>
      expect(window.location.href.startsWith("https://corp.example.com/auth/start?return_to=")).toBe(true),
    )
  })

  it("shows the expired notice", () => {
    render(() => <LoginScreen onSettings={() => {}} expired />)
    expect(screen.getByText("Sign-in expired, try again")).toBeTruthy()
  })

  it("calls onLoggedIn after a successful native sign-in", async () => {
    vi.spyOn(auth, "login").mockResolvedValue("ok")
    const onLoggedIn = vi.fn()
    render(() => <LoginScreen onSettings={vi.fn()} onLoggedIn={onLoggedIn} />)
    await fireEvent.click(screen.getByText("Sign in with OIDC"))
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledOnce())
    expect(screen.queryByText("Sign-in failed, try again")).toBeNull()
  })

  it("shows an error when sign-in fails", async () => {
    vi.spyOn(auth, "login").mockResolvedValue("failed")
    render(() => <LoginScreen onSettings={vi.fn()} />)
    await fireEvent.click(screen.getByText("Sign in with OIDC"))
    await vi.waitFor(() => expect(screen.getByText("Sign-in failed, try again")).toBeTruthy())
  })

  it("ignores a second click while sign-in is in flight", async () => {
    let resolveLogin: (value: "ok" | "failed" | "cancelled") => void = () => {}
    const loginPromise = new Promise<"ok" | "failed" | "cancelled">((resolve) => {
      resolveLogin = resolve
    })
    const loginSpy = vi.spyOn(auth, "login").mockReturnValue(loginPromise)
    render(() => <LoginScreen onSettings={vi.fn()} />)
    const button = screen.getByText("Sign in with OIDC")
    await fireEvent.click(button)
    await fireEvent.click(button)
    resolveLogin("ok")
    await vi.waitFor(() => expect(loginSpy).toHaveBeenCalledOnce())
  })

  it("stays quiet when sign-in is cancelled", async () => {
    vi.spyOn(auth, "login").mockResolvedValue("cancelled")
    const onLoggedIn = vi.fn()
    render(() => <LoginScreen onSettings={vi.fn()} onLoggedIn={onLoggedIn} />)
    await fireEvent.click(screen.getByText("Sign in with OIDC"))
    await Promise.resolve()
    expect(onLoggedIn).not.toHaveBeenCalled()
    expect(screen.queryByText("Sign-in failed, try again")).toBeNull()
  })
})
