import { type Component, Show } from "solid-js"
import type { UserInfo } from "./api"
import { getBaseUrl, isCapacitor } from "./api"

export const UserBar: Component<{ user: UserInfo; onSettings?: () => void }> = (props) => {
  const displayId = () => props.user.email.split("@")[0] || props.user.sub

  return (
    <header class="shrink-0 h-9 flex items-center justify-between px-3 border-b border-v2-border-border-base bg-v2-background-bg-deep">
      <button
        class="text-[13px] font-medium text-v2-text-text-muted hover:text-v2-text-text-base cursor-pointer bg-transparent border-none p-0 transition-colors"
        onClick={() => { window.location.href = "/" }}
      >
        opencode-rc
      </button>
      <div class="flex items-center gap-2">
        <span class="text-[12px] text-v2-text-text-muted">{displayId()}</span>
        <Show when={props.onSettings && isCapacitor()}>
          <button
            class="flex items-center justify-center size-6 rounded-md text-v2-icon-icon-muted hover:text-v2-text-text-base hover:bg-v2-background-bg-layer-01 cursor-pointer bg-transparent border-none p-0 transition-colors"
            onClick={props.onSettings}
            title="Server settings"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 10a2 2 0 100-4 2 2 0 000 4z" stroke="currentColor" stroke-width="1.3" />
              <path d="M13.5 8a5.5 5.5 0 01-.08.93l1.52 1.2a.36.36 0 01.09.46l-1.44 2.49a.36.36 0 01-.44.16l-1.79-.72a5.3 5.3 0 01-1.61.93l-.27 1.9a.36.36 0 01-.36.31H6.88a.36.36 0 01-.36-.31l-.27-1.9a5.3 5.3 0 01-1.61-.93l-1.79.72a.36.36 0 01-.44-.16L1.07 10.6a.36.36 0 01.09-.46l1.52-1.2A5.6 5.6 0 012.5 8c0-.31.03-.63.08-.93L1.06 5.87a.36.36 0 01-.09-.46l1.44-2.49a.36.36 0 01.44-.16l1.79.72a5.3 5.3 0 011.61-.93l.27-1.9A.36.36 0 016.88.34h2.24c.18 0 .33.13.36.31l.27 1.9c.59.2 1.13.52 1.61.93l1.79-.72a.36.36 0 01.44.16l1.44 2.49a.36.36 0 01-.09.46l-1.52 1.2c.05.3.08.62.08.93z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
            </svg>
          </button>
        </Show>
        <button
          class="flex items-center justify-center size-6 rounded-md text-v2-icon-icon-muted hover:text-v2-text-text-base hover:bg-v2-background-bg-layer-01 cursor-pointer bg-transparent border-none p-0 transition-colors"
          onClick={() => {
            const base = getBaseUrl()
            window.location.href = base ? `${base}/auth/logout` : "/auth/logout"
          }}
          title="Sign out"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M6 2H4a2 2 0 00-2 2v8a2 2 0 002 2h2M10.5 11.5L14 8l-3.5-3.5M14 8H6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </header>
  )
}
