import { type Component, createSignal } from "solid-js"
import { getBaseUrl, setBaseUrl } from "./api"
import { MIN_SERVER_PROTOCOL, readProtocol } from "./protocol"

export const ConfigScreen: Component<{ onSave: () => void; onCancel?: () => void }> = (props) => {
  const [url, setUrl] = createSignal(getBaseUrl())
  const [error, setError] = createSignal("")
  const [testing, setTesting] = createSignal(false)

  const handleSave = async () => {
    const value = url().trim().replace(/\/+$/, "")
    if (!value) {
      setError("Enter a server URL")
      return
    }

    try {
      new URL(value)
    } catch {
      setError("Invalid URL")
      return
    }

    setTesting(true)
    setError("")

    let res: Response
    try {
      res = await fetch(`${value}/healthz`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`${res.status}`)
    } catch (e: any) {
      setError(`Cannot reach server: ${e.message || "connection failed"}`)
      setTesting(false)
      return
    }

    const health = (await res.json().catch(() => ({}))) as { protocol?: unknown }
    if (readProtocol(String(health.protocol ?? "")) < MIN_SERVER_PROTOCOL) {
      setError("This server is older than this app supports. Ask your administrator to upgrade it.")
      setTesting(false)
      return
    }

    setBaseUrl(value)
    setTesting(false)
    props.onSave()
  }

  return (
    <div class="flex flex-1 flex-col items-center justify-center bg-v2-background-bg-deep px-6">
      <div class="w-full max-w-sm">
        <h1 class="text-[20px] font-semibold text-v2-text-text-base mb-1">
          Connect to Server
        </h1>
        <p class="text-13-regular text-v2-text-text-faint mb-6">
          Enter your OpenCode RC server URL.
        </p>

        <label class="block text-[12px] font-medium text-v2-text-text-muted mb-1.5">
          Server URL
        </label>
        <input
          type="url"
          placeholder={window.location.origin}
          value={url()}
          onInput={(e) => { setUrl(e.currentTarget.value); setError("") }}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave() }}
          class="w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-3 py-2 text-[14px] text-v2-text-text-base placeholder:text-v2-text-text-faint outline-none focus:border-v2-border-border-muted transition-colors"
        />

        {error() && (
          <p class="mt-2 text-[12px] text-red-500">{error()}</p>
        )}

        <div class="mt-4 flex gap-3">
          {props.onCancel && (
            <button
              onClick={props.onCancel}
              class="flex-1 rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-4 py-2 text-[14px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-background-bg-hover cursor-pointer"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={testing()}
            class="flex-1 rounded-md bg-v2-text-text-base text-v2-background-bg-deep px-4 py-2 text-[14px] font-medium transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer border-none"
          >
            {testing() ? "Connecting..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}
