import { type Component } from "solid-js"
import type { UserInfo } from "./api"

export const UserBar: Component<{ user: UserInfo }> = (props) => {
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
        <button
          class="flex items-center justify-center size-6 rounded-md text-v2-icon-icon-muted hover:text-v2-text-text-base hover:bg-v2-background-bg-layer-01 cursor-pointer bg-transparent border-none p-0 transition-colors"
          onClick={() => { window.location.href = "/auth/logout" }}
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
