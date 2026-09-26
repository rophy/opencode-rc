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

import { delegateEvents, render } from "solid-js/web"
import { createEffect, createResource, createSignal, Match, onCleanup, Switch } from "solid-js"
import {
  AppBaseProviders,
  AppInterface,
  PlatformProvider,
  ServerConnection,
  useLayout,
  useServerSync,
  type Platform,
} from "@opencode-ai/app"
import {
  createRouter,
  createBeforeLeave,
  keepDepth,
  saveCurrentDepth,
  notifyIfNotBlocked,
} from "@solidjs/router"
import "@opencode-ai/app/index.css"
import { fetchMe, getBaseUrl, isPreConfigured, loadConfig } from "./api"
import { completeLogin, getAccessToken, getCachedAccessToken, invalidateAccessToken, onLoggedOut } from "./auth"
import { installProxyFetch, installProxyWebSocket } from "./proxy-fetch"
import { UserBar } from "./user-bar"
import { SessionPicker } from "./session-picker"
import { ConfigScreen } from "./config-screen"
import { LoginScreen } from "./login-screen"
import { protocolState } from "./protocol"
import { ProtocolScreen } from "./protocol-screen"

const platform: Platform = {
  platform: "web",
  openExternal: (url) => {
    if (!URL.canParse(url)) return
    const u = new URL(url)
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "mailto:") return
    window.open(u.href, "_blank", "noopener,noreferrer")
  },
  restart: async () => window.location.reload(),
  notify: async () => {},
}

function AutoOpenProjects() {
  const layout = useLayout()
  const sync = useServerSync()
  createEffect(() => {
    const projects = sync().data.project
    for (const project of projects) {
      layout.projects.open(project.worktree)
    }
  })
  return null
}

function getSessionIdFromPath(): string | null {
  const match = location.pathname.match(/^\/s\/([^/]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

function App(props: { loginExpired: boolean }) {
  const [showConfig, setShowConfig] = createSignal(false)
  const [user, { refetch: refetchUser }] = createResource(fetchMe)
  onLoggedOut(() => refetchUser())
  const sessionId = getSessionIdFromPath()

  return (
    <Switch>
      <Match when={protocolState() !== "ok"}>
        <ProtocolScreen state={protocolState() as "client_outdated" | "server_outdated"} />
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
      <Match when={user() && !sessionId}>
        <UserBar user={user()!} onSettings={() => setShowConfig(true)} />
        <SessionPicker user={user()!} />
      </Match>
      <Match when={user() && sessionId}>
        {(() => {
          const sessionPrefix = `/s/${sessionId}`
          const serverOrigin = getBaseUrl() || location.origin
          const proxyUrl = `${serverOrigin}/proxy/${sessionId}/`

          const proxyOpts = { pageOrigin: location.origin, serverOrigin, sessionId: sessionId! }
          installProxyFetch({ ...proxyOpts, getToken: getAccessToken, invalidate: invalidateAccessToken })
          installProxyWebSocket({
            ...proxyOpts,
            getCachedToken: getCachedAccessToken,
            warmToken: () => void getAccessToken(),
          })

          const server: ServerConnection.Http = {
            type: "http",
            http: { url: proxyUrl },
          }
          const serverKey = ServerConnection.key(server)

          const beforeLeave = createBeforeLeave()
          const getSource = () => {
            const fullPath = window.location.pathname.replace(/^\/+/, "/")
            const stripped = fullPath.startsWith(sessionPrefix)
              ? fullPath.slice(sessionPrefix.length) || "/"
              : fullPath
            const search = window.location.search
            const state = window.history.state && window.history.state._depth && Object.keys(window.history.state).length === 1 ? undefined : window.history.state
            return { value: stripped + search + window.location.hash, state }
          }
          const SessionRouter = createRouter({
            get: getSource,
            set({ value, replace, scroll, state }) {
              const prefixed = sessionPrefix + (value.startsWith("/") ? value : "/" + value)
              if (replace) {
                window.history.replaceState(keepDepth(state), "", prefixed)
              } else {
                window.history.pushState(state, "", prefixed)
              }
              const hash = decodeURIComponent(window.location.hash.slice(1))
              const el = hash && document.getElementById(hash)
              if (el) el.scrollIntoView()
              else if (scroll) window.scrollTo(0, 0)
              saveCurrentDepth()
            },
            init: notify => {
              const handler = notifyIfNotBlocked(notify, delta => {
                if (delta) return !beforeLeave.confirm(delta)
                const s = getSource()
                return !beforeLeave.confirm(s.value, { state: s.state })
              })
              window.addEventListener("popstate", handler)
              return () => window.removeEventListener("popstate", handler)
            },
            create: router => {
              const navigateFromRoute = router.navigatorFactory(router.base)
              delegateEvents(["click", "submit"])
              function handleAnchorClick(evt: MouseEvent) {
                if (evt.defaultPrevented || evt.button !== 0 || evt.metaKey || evt.altKey || evt.ctrlKey || evt.shiftKey) return
                const a = evt.composedPath().find((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement)
                if (!a) return
                const href = a.href
                const target = a.target
                if (target || (!href && !a.hasAttribute("state"))) return
                const rel = (a.getAttribute("rel") || "").split(/\s+/)
                if (a.hasAttribute("download") || rel.includes("external")) return
                const url = new URL(href)
                if (url.origin !== window.location.origin) return
                let pathname = url.pathname
                if (pathname.startsWith(sessionPrefix)) {
                  pathname = pathname.slice(sessionPrefix.length) || "/"
                }
                const to = pathname + url.search + url.hash
                const linkState = a.getAttribute("state")
                evt.preventDefault()
                navigateFromRoute(to, {
                  resolve: false,
                  replace: a.hasAttribute("replace"),
                  scroll: !a.hasAttribute("noscroll"),
                  state: linkState ? JSON.parse(linkState) : undefined,
                })
              }
              document.addEventListener("click", handleAnchorClick)
              onCleanup(() => document.removeEventListener("click", handleAnchorClick))
            },
            utils: {
              go: (delta: number) => window.history.go(delta),
              beforeLeave,
            },
          })

          return (
            <PlatformProvider value={platform}>
              <AppBaseProviders>
                <div class="flex flex-col h-dvh">
                    <UserBar user={user()!} onSettings={() => setShowConfig(true)} />
                    <div class="flex-1 min-h-0 flex flex-col">
                      <AppInterface
                        defaultServer={serverKey}
                        canonicalLocalServer={serverKey}
                        servers={[server]}
                        disableHealthCheck
                        router={SessionRouter}
                        serverScoped={<AutoOpenProjects />}
                      />
                    </div>
                  </div>
              </AppBaseProviders>
            </PlatformProvider>
          )
        })()}
      </Match>
    </Switch>
  )
}

const root = document.getElementById("root")
if (root) {
  loadConfig()
    .then(() => completeLogin())
    .then((result) => render(() => <App loginExpired={result === "expired"} />, root))
}
