import { type Component } from "solid-js"
import { getBaseUrl } from "./api"

export const LoginScreen: Component<{ onSettings: () => void }> = (props) => {
  const handleLogin = () => {
    const base = getBaseUrl()
    window.location.href = base ? `${base}/auth/login` : "/auth/login"
  }

  return (
    <div class="flex flex-1 flex-col items-center justify-center bg-v2-background-bg-deep px-6">
      <div class="w-full max-w-sm text-center">
        <h1 class="text-[22px] font-semibold text-v2-text-text-base mb-2">
          OpenCode RC
        </h1>
        <p class="text-13-regular text-v2-text-text-faint mb-8">
          Sign in to access your dev sessions.
        </p>

        <button
          onClick={handleLogin}
          class="w-full rounded-md bg-v2-text-text-base text-v2-background-bg-deep px-4 py-2.5 text-[14px] font-medium transition-opacity hover:opacity-90 cursor-pointer border-none"
        >
          Login with OIDC
        </button>

        <button
          onClick={props.onSettings}
          class="mt-3 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-4 py-2 text-[13px] text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-01 cursor-pointer"
        >
          Server Settings
        </button>
      </div>
    </div>
  )
}
