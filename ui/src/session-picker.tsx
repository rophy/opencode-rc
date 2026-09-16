import { type Component, For, Show, createResource, createSignal } from "solid-js"
import { fetchSessions, type UserInfo, type DevSession } from "./api"

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function directoryName(dir: string): string {
  return dir.split("/").pop() || dir
}

function SessionCard(props: { session: DevSession }) {
  return (
    <a
      href={`/s/${encodeURIComponent(props.session.id)}/`}
      class="group flex items-start gap-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-base p-3.5 transition-[background-color,border-color] duration-150 hover:bg-v2-background-bg-layer-01 hover:border-v2-border-border-muted"
    >
      <div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-v2-background-bg-layer-03 text-v2-text-text-muted">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 4.5A1.5 1.5 0 013.5 3h3.379a1.5 1.5 0 011.06.44l.622.62a1.5 1.5 0 001.06.44H12.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="text-14-medium text-v2-text-text-base truncate">
            {directoryName(props.session.directory)}
          </span>
          <span class="shrink-0 rounded-[3px] border border-v2-border-border-base px-1.5 py-0.5 text-[10px] leading-none text-v2-text-text-faint">
            {props.session.id.slice(0, 8)}
          </span>
        </div>
        <div class="mt-1 text-12-regular text-v2-text-text-faint truncate">
          {props.session.directory}
        </div>
        <div class="mt-1.5 flex items-center gap-3 text-[11px] text-v2-text-text-faint">
          <span class="flex items-center gap-1">
            <span class="inline-block size-1.5 rounded-full bg-green-500" />
            Active
          </span>
          <span>Last seen {timeAgo(props.session.lastHeartbeat)}</span>
        </div>
      </div>
      <svg
        class="mt-1 size-4 shrink-0 text-v2-icon-icon-muted opacity-0 transition-opacity group-hover:opacity-100"
        viewBox="0 0 16 16" fill="none"
      >
        <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </a>
  )
}

export const SessionPicker: Component<{ user: UserInfo }> = (props) => {
  const [sessions, { refetch }] = createResource(fetchSessions)
  const [refreshing, setRefreshing] = createSignal(false)

  const handleRefresh = async () => {
    setRefreshing(true)
    await refetch()
    setRefreshing(false)
  }

  return (
    <div class="flex flex-1 flex-col items-center bg-v2-background-bg-deep">
      <div class="w-full max-w-lg px-6 pt-12 pb-8">
        <div class="mb-1.5 flex items-center gap-2">
          <h1 class="text-[18px] font-semibold text-v2-text-text-base leading-tight">
            Sessions
          </h1>
          <button
            onClick={handleRefresh}
            disabled={refreshing()}
            class="flex size-6 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-muted disabled:opacity-40"
            title="Refresh"
          >
            <svg
              class="size-3.5"
              classList={{ "animate-spin": refreshing() }}
              viewBox="0 0 16 16" fill="none"
            >
              <path d="M13.5 2.5v4h-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M12.1 6.5A5 5 0 103.5 11.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
        </div>
        <p class="text-13-regular text-v2-text-text-faint mb-6">
          Select a dev machine session to open OpenCode.
        </p>

        <div class="flex flex-col gap-2">
          <Show when={!sessions.loading} fallback={
            <div class="flex items-center justify-center py-12 text-v2-text-text-faint text-13-regular">
              Loading sessions...
            </div>
          }>
            <For each={sessions()} fallback={
              <div class="rounded-lg border border-dashed border-v2-border-border-base bg-v2-background-bg-base p-6 text-center">
                <div class="text-14-medium text-v2-text-text-muted mb-1.5">
                  No active sessions
                </div>
                <p class="text-12-regular text-v2-text-text-faint max-w-xs mx-auto">
                  Run <code class="rounded bg-v2-background-bg-layer-03 px-1 py-0.5 text-[11px] font-mono">opencode-rc</code> on your dev machine to register a session.
                </p>
              </div>
            }>
              {(session) => <SessionCard session={session} />}
            </For>
          </Show>
        </div>
      </div>
    </div>
  )
}
