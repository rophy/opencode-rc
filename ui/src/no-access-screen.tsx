import { type Component } from "solid-js"

export const NoAccessScreen: Component<{ email: string; onRetry: () => void }> = (props) => (
  <div class="flex flex-1 flex-col items-center bg-v2-background-bg-base">
    <div class="w-full max-w-lg px-6 pt-16 pb-8 text-center">
      <h1 class="text-[18px] font-semibold text-v2-text-text-base leading-tight mb-4">No access</h1>
      <p class="text-13-regular text-v2-text-text-muted mb-6">
        You are signed in as {props.email || "this account"}, but it is not allowed to use remote sessions. Ask your
        administrator for access.
      </p>
      <button
        onClick={() => props.onRetry()}
        class="inline-flex items-center rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-4 py-2 text-[13px] font-medium text-v2-text-text-base cursor-pointer"
      >
        Check again
      </button>
    </div>
  </div>
)
