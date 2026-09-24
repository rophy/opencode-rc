import { type Component, Show } from "solid-js"
import { isPreConfigured } from "./api"
import { login } from "./auth"

export const LoginScreen: Component<{ onSettings: () => void; expired?: boolean }> = (props) => {
  return (
    <div class="flex flex-1 flex-col items-center bg-v2-background-bg-base">
      <div class="w-full max-w-lg px-6 pt-16 pb-8 text-center">
        <div class="text-v2-text-text-muted text-14-medium mb-2">
          Welcome to
        </div>
        <h1 class="text-[18px] font-semibold text-v2-text-text-base leading-tight mb-2">
          opencode-rc
        </h1>
        <p class="text-13-regular text-v2-text-text-faint mb-8">
          Sign in to access your dev sessions.
        </p>

        <Show when={props.expired}>
          <p class="text-13-regular text-red-500 mb-4">Sign-in expired, try again</p>
        </Show>

        <button
          onClick={() => void login()}
          class="inline-flex items-center gap-2 rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-4 py-2 text-[13px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-background-bg-hover cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2.5a2 2 0 110 4 2 2 0 010-4zm0 9.5a5.5 5.5 0 01-4.24-2c.02-1.4 2.83-2.17 4.24-2.17s4.22.78 4.24 2.17A5.5 5.5 0 018 13z" fill="currentColor" opacity="0.5" />
          </svg>
          Sign in with OIDC
        </button>

        <Show when={!isPreConfigured()}>
          <div class="mt-6">
            <button
              onClick={props.onSettings}
              class="inline-flex items-center gap-1.5 text-[12px] text-v2-text-text-faint hover:text-v2-text-text-muted transition-colors cursor-pointer bg-transparent border-none p-0"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M8 10a2 2 0 100-4 2 2 0 000 4z" stroke="currentColor" stroke-width="1.3" />
                <path d="M13.5 8a5.5 5.5 0 01-.08.93l1.52 1.2a.36.36 0 01.09.46l-1.44 2.49a.36.36 0 01-.44.16l-1.79-.72a5.3 5.3 0 01-1.61.93l-.27 1.9a.36.36 0 01-.36.31H6.88a.36.36 0 01-.36-.31l-.27-1.9a5.3 5.3 0 01-1.61-.93l-1.79.72a.36.36 0 01-.44-.16L1.07 10.6a.36.36 0 01.09-.46l1.52-1.2A5.6 5.6 0 012.5 8c0-.31.03-.63.08-.93L1.06 5.87a.36.36 0 01-.09-.46l1.44-2.49a.36.36 0 01.44-.16l1.79.72a5.3 5.3 0 011.61-.93l.27-1.9A.36.36 0 016.88.34h2.24c.18 0 .33.13.36.31l.27 1.9c.59.2 1.13.52 1.61.93l1.79-.72a.36.36 0 01.44.16l1.44 2.49a.36.36 0 01-.09.46l-1.52 1.2c.05.3.08.62.08.93z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
              </svg>
              Server settings
            </button>
          </div>
        </Show>
      </div>
    </div>
  )
}
