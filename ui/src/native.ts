// The bridge to the app shells (ui/ios/App/App/Bridge.swift, ui/android/.../Bridge.java).
// iOS: a WKScriptMessageHandlerWithReply named "rcNative"; postMessage returns a promise and
// errors arrive as "<code>: <message>". Native events call window.__rcNativeEmit.
// Android: a WebMessageListener object "rcNativePort", limited to the app origin; JSON messages
// with ids, and events as { event, data }.
export type NativePlatform = "ios" | "android"

export class NativeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface IOSHandler {
  postMessage(message: unknown): Promise<unknown>
}

interface AndroidPort {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

type Handler = (data: unknown) => void

const g = globalThis as { webkit?: { messageHandlers?: { rcNative?: IOSHandler } }; rcNativePort?: AndroidPort }

function iosHandler(): IOSHandler | undefined {
  return g.webkit?.messageHandlers?.rcNative
}

function androidPort(): AndroidPort | undefined {
  return g.rcNativePort
}

export function nativePlatform(): NativePlatform | null {
  if (iosHandler()) return "ios"
  if (androidPort()) return "android"
  return null
}

export function isNativeApp(): boolean {
  return nativePlatform() !== null
}

const handlers = new Map<string, Set<Handler>>()

function emit(event: string, data: unknown) {
  for (const handler of handlers.get(event) ?? []) handler(data)
}

;(globalThis as { __rcNativeEmit?: typeof emit }).__rcNativeEmit = emit

export function nativeOn(event: string, handler: Handler): () => void {
  const port = androidPort()
  if (port) wire(port)
  let set = handlers.get(event)
  if (!set) handlers.set(event, (set = new Set()))
  set.add(handler)
  return () => set.delete(handler)
}

function toNativeError(err: unknown): NativeError {
  const text = err instanceof Error ? err.message : String(err)
  const match = text.match(/^([a-z_]+): ?([\s\S]*)$/)
  return match ? new NativeError(match[1], match[2]) : new NativeError("failed", text)
}

let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
let wiredPort: AndroidPort | null = null

function wire(port: AndroidPort) {
  if (wiredPort === port) return
  wiredPort = port
  port.onmessage = (e) => {
    let msg: { id?: number; result?: unknown; error?: { code?: string; message?: string }; event?: string; data?: unknown }
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }
    if (typeof msg.event === "string") return emit(msg.event, msg.data)
    const call = msg.id === undefined ? undefined : pending.get(msg.id)
    if (!call) return
    pending.delete(msg.id!)
    if (msg.error) call.reject(new NativeError(msg.error.code ?? "failed", msg.error.message ?? ""))
    else call.resolve(msg.result)
  }
}

export async function nativeCall<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const ios = iosHandler()
  if (ios) {
    try {
      return (await ios.postMessage({ method, args })) as T
    } catch (err) {
      throw toNativeError(err)
    }
  }
  const port = androidPort()
  if (!port) throw new NativeError("failed", "not running in the app")
  wire(port)
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    port.postMessage(JSON.stringify({ id, method, args }))
  })
}
