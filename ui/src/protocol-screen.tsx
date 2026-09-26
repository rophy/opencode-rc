import { type Component, Show } from "solid-js"
import { Capacitor } from "@capacitor/core"

export const ProtocolScreen: Component<{ state: "client_outdated" | "server_outdated" }> = (props) => {
  const native = Capacitor.isNativePlatform()
  const message = () =>
    props.state === "server_outdated"
      ? "Your OpenCode RC server is older than this app supports. Ask your administrator to upgrade it."
      : native
        ? "This version of OpenCode RC is no longer supported by your server. Please update the app."
        : "A new version of OpenCode RC is available."
  return (
    <div class="flex flex-1 flex-col items-center bg-v2-background-bg-base">
      <div class="w-full max-w-lg px-6 pt-16 pb-8 text-center">
        <h1 class="text-[18px] font-semibold text-v2-text-text-base leading-tight mb-4">opencode-rc</h1>
        <p class="text-13-regular text-v2-text-text-muted mb-6">{message()}</p>
        <Show when={props.state === "client_outdated" && !native}>
          <button
            onClick={() => window.location.reload()}
            class="inline-flex items-center rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-4 py-2 text-[13px] font-medium text-v2-text-text-base cursor-pointer"
          >
            Reload
          </button>
        </Show>
      </div>
    </div>
  )
}
