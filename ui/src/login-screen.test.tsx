import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@solidjs/testing-library"
import { LoginScreen } from "./login-screen"

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("LoginScreen", () => {
  it("renders login and settings buttons", () => {
    render(() => <LoginScreen onSettings={vi.fn()} />)
    expect(screen.getByText("Login with OIDC")).toBeTruthy()
    expect(screen.getByText("Server Settings")).toBeTruthy()
  })

  it("calls onSettings when Server Settings is clicked", async () => {
    const onSettings = vi.fn()
    render(() => <LoginScreen onSettings={onSettings} />)
    await fireEvent.click(screen.getByText("Server Settings"))
    expect(onSettings).toHaveBeenCalledOnce()
  })

  it("redirects to /auth/login when no base URL", async () => {
    render(() => <LoginScreen onSettings={vi.fn()} />)
    const orig = window.location.href
    Object.defineProperty(window, "location", {
      value: { ...window.location, href: orig },
      writable: true,
    })
    await fireEvent.click(screen.getByText("Login with OIDC"))
    expect(window.location.href).toBe("/auth/login")
  })

  it("redirects to base URL /auth/login when configured", async () => {
    localStorage.setItem("opencode-rc-endpoint", "https://rc.example.com")
    render(() => <LoginScreen onSettings={vi.fn()} />)
    Object.defineProperty(window, "location", {
      value: { ...window.location, href: "" },
      writable: true,
    })
    await fireEvent.click(screen.getByText("Login with OIDC"))
    expect(window.location.href).toBe("https://rc.example.com/auth/login")
  })
})
