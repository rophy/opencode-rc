// Polyfill Map.groupBy and Object.groupBy for older WebViews (Chrome < 117)
if (typeof Map.groupBy !== "function") {
  Map.groupBy = function <K, T>(items: Iterable<T>, keySelector: (item: T, index: number) => K): Map<K, T[]> {
    const map = new Map<K, T[]>()
    let i = 0
    for (const item of items) {
      const key = keySelector(item, i++)
      const group = map.get(key)
      if (group) group.push(item)
      else map.set(key, [item])
    }
    return map
  }
}
if (typeof Object.groupBy !== "function") {
  Object.groupBy = function <K extends PropertyKey, T>(items: Iterable<T>, keySelector: (item: T, index: number) => K): Partial<Record<K, T[]>> {
    const result = {} as Record<K, T[]>
    let i = 0
    for (const item of items) {
      const key = keySelector(item, i++)
      ;(result[key] ??= []).push(item)
    }
    return result
  }
}


import { render } from "solid-js/web"
import { createResource, createSignal, Match, Show, Switch } from "solid-js"
import { fetchMe, fetchSessions, isPreConfigured, type UserInfo } from "./api"
import { completeLogin, onLoggedOut } from "./auth"
import { UserBar } from "./user-bar"
import { SessionPicker } from "./session-picker"
import { ConfigScreen } from "./config-screen"
import { LoginScreen } from "./login-screen"
import { protocolState, resetProtocolState } from "./protocol"
import { ProtocolScreen } from "./protocol-screen"
import { NoAccessScreen } from "./no-access-screen"
import { accessRecheck } from "./access-recheck"
import { BASE } from "./build-info"
import { mismatchRedirect } from "./opencode-version"
import { SessionView } from "#session-view"

function getSessionIdFromPath(): string | null {
  const base = BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = location.pathname.match(new RegExp(`^${base}/s/([^/]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

// A session belongs to the build for its opencode version. Look it up first and move to the
// other build when this one is the wrong one; an unknown session renders as before (the API
// answers it).
function SessionGate(props: { sessionId: string; user: UserInfo; onSettings: () => void; onForbidden: () => void }) {
  const [target] = createResource(async () => {
    const sessions = await fetchSessions().catch(() => [])
    const url = mismatchRedirect(sessions, {
      base: BASE,
      id: props.sessionId,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    })
    if (url) location.replace(url)
    return url
  })
  return (
    <Show
      when={!target.loading && !target()}
      fallback={<div class="flex items-center justify-center h-dvh text-v2-text-tertiary">Loading...</div>}
    >
      <SessionView
        sessionId={props.sessionId}
        user={props.user}
        onSettings={props.onSettings}
        onForbidden={props.onForbidden}
      />
    </Show>
  )
}

function App(props: { loginExpired: boolean }) {
  const [showConfig, setShowConfig] = createSignal(false)
  const [user, { refetch: refetchUser, mutate: setUser }] = createResource(fetchMe)
  // A revoked user's open session ends with 403s (and a terminal closed with 1008): show the
  // denial. Not a refetch, which would unmount the session while it loads.
  const recheckAccess = accessRecheck(fetchMe, setUser)
  onLoggedOut(() => refetchUser())
  const sessionId = getSessionIdFromPath()

  return (
    <Switch>
      <Match when={protocolState() !== "ok"}>
        <ProtocolScreen
          state={protocolState() as "client_outdated" | "server_outdated"}
          onChangeServer={
            !isPreConfigured()
              ? () => {
                  resetProtocolState()
                  setShowConfig(true)
                }
              : undefined
          }
        />
      </Match>
      <Match when={showConfig()}>
        <ConfigScreen onSave={() => { setShowConfig(false); refetchUser() }} onCancel={() => setShowConfig(false)} />
      </Match>
      <Match when={user.loading}>
        <div class="flex items-center justify-center h-dvh text-v2-text-tertiary">
          Loading...
        </div>
      </Match>
      <Match when={user.error || !user()}>
        <LoginScreen onSettings={() => setShowConfig(true)} onLoggedIn={() => refetchUser()} expired={props.loginExpired} />
      </Match>
      <Match when={user()?.allowed === false}>
        <UserBar user={user()!} onSettings={() => setShowConfig(true)} />
        <NoAccessScreen email={user()!.email} reason={user()!.reason} onRetry={() => refetchUser()} />
      </Match>
      <Match when={user() && !sessionId}>
        <UserBar user={user()!} onSettings={() => setShowConfig(true)} />
        <SessionPicker user={user()!} />
      </Match>
      <Match when={user() && sessionId}>
        <SessionGate
          sessionId={sessionId!}
          user={user()!}
          onSettings={() => setShowConfig(true)}
          onForbidden={recheckAccess}
        />
      </Match>
    </Switch>
  )
}

const root = document.getElementById("root")
if (root) {
  completeLogin().then((result) => render(() => <App loginExpired={result === "expired"} />, root))
}
