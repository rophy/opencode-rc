import { createSignal } from "solid-js"

// Client/server compatibility with the API, independent of release versions
// (docs/api-versioning.md). Raise MIN_SERVER_PROTOCOL when the UI relies on newer
// server behaviour; bump PROTOCOL when the server needs to tell this UI apart.
export const PROTOCOL_HEADER = "OpenCode-RC-Protocol"
export const PROTOCOL = 1
export const MIN_SERVER_PROTOCOL = 1

export type ProtocolState = "ok" | "client_outdated" | "server_outdated"

const [state, setState] = createSignal<ProtocolState>("ok")
export const protocolState = state

export function resetProtocolState(): void {
  setState("ok")
}

export function readProtocol(value: string | null | undefined): number {
  return value && /^\d+$/.test(value) ? Number(value) : 0
}

export function withProtocol(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers)
  headers.set(PROTOCOL_HEADER, String(PROTOCOL))
  return { ...init, headers }
}

// Inspects a response from the API: a 426 client_outdated means this UI is too old;
// a missing or too-low server header means the server is too old.
export async function checkProtocol(res: Response): Promise<void> {
  if (res.status === 426) {
    try {
      const body = (await res.clone().json()) as { error?: string }
      if (body.error === "client_outdated") {
        setState("client_outdated")
        return
      }
    } catch {}
  }
  if (res.status < 500 && readProtocol(res.headers.get(PROTOCOL_HEADER)) < MIN_SERVER_PROTOCOL) setState("server_outdated")
}
