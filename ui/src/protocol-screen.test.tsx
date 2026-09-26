import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@solidjs/testing-library"

const native = vi.hoisted(() => ({ value: false }))
vi.mock("@capacitor/core", async (orig) => ({
  ...(await orig<typeof import("@capacitor/core")>()),
  Capacitor: { isNativePlatform: () => native.value },
}))

import { ProtocolScreen } from "./protocol-screen"

afterEach(() => { cleanup(); native.value = false })

describe("ProtocolScreen", () => {
  it("asks web users to reload", async () => {
    const reload = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as unknown as Location)
    render(() => <ProtocolScreen state="client_outdated" />)
    expect(screen.getByText("A new version of OpenCode RC is available.")).toBeTruthy()
    await fireEvent.click(screen.getByText("Reload"))
    expect(reload).toHaveBeenCalled()
  })

  it("asks app users to update the app", () => {
    native.value = true
    render(() => <ProtocolScreen state="client_outdated" />)
    expect(screen.getByText("This version of OpenCode RC is no longer supported by your server. Please update the app.")).toBeTruthy()
    expect(screen.queryByText("Reload")).toBeNull()
  })

  it("explains an outdated server", () => {
    render(() => <ProtocolScreen state="server_outdated" />)
    expect(screen.getByText("Your OpenCode RC server is older than this app supports. Ask your administrator to upgrade it.")).toBeTruthy()
  })

  it("web server_outdated shows a Reload button", async () => {
    const reload = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as unknown as Location)
    render(() => <ProtocolScreen state="server_outdated" />)
    await fireEvent.click(screen.getByText("Reload"))
    expect(reload).toHaveBeenCalled()
  })

  it("native server_outdated with onChangeServer shows Change server and calls it", async () => {
    native.value = true
    const onChangeServer = vi.fn()
    render(() => <ProtocolScreen state="server_outdated" onChangeServer={onChangeServer} />)
    await fireEvent.click(screen.getByText("Change server"))
    expect(onChangeServer).toHaveBeenCalled()
    expect(screen.queryByText("Reload")).toBeNull()
  })

  it("native server_outdated without onChangeServer shows no button", () => {
    native.value = true
    render(() => <ProtocolScreen state="server_outdated" />)
    expect(screen.queryByText("Change server")).toBeNull()
    expect(screen.queryByText("Reload")).toBeNull()
  })
})
