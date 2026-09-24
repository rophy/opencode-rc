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
import { dropBogusContentLength } from "./fix-response"
import { UserBar } from "./user-bar"
import { SessionPicker } from "./session-picker"
import { ConfigScreen } from "./config-screen"
import { LoginScreen } from "./login-screen"

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

function App() {
  const [showConfig, setShowConfig] = createSignal(false)
  const [user, { refetch: refetchUser }] = createResource(fetchMe)
  const sessionId = getSessionIdFromPath()

  return (
    <Switch>
      <Match when={showConfig()}>
        <ConfigScreen onSave={() => { setShowConfig(false); refetchUser() }} onCancel={() => setShowConfig(false)} />
      </Match>
      <Match when={user.loading}>
        <div class="flex items-center justify-center h-dvh text-v2-text-tertiary">
          Loading...
        </div>
      </Match>
      <Match when={user.error || !user()}>
        <LoginScreen onSettings={() => setShowConfig(true)} />
      </Match>
      <Match when={user() && !sessionId}>
        <UserBar user={user()!} onSettings={() => setShowConfig(true)} />
        <SessionPicker user={user()!} />
      </Match>
      <Match when={user() && sessionId}>
        {(() => {
          const sessionPrefix = `/s/${sessionId}`
          const serverOrigin = getBaseUrl() || location.origin
          const proxyUrl = `${serverOrigin}${sessionPrefix}/`

          // Patch globalThis.fetch to rewrite OpenCode API paths through the session proxy.
          // The SDK uses absolute paths ("/api/...", "/global/...", "/session/...", etc.)
          // in new URL(path, baseUrl), which strips the /s/{sessionId}/ prefix.
          // This intercept prepends the prefix for all same-origin requests that
          // aren't already under /s/, /auth/, /gateway/, or /healthz.
          // On mobile (Capacitor), location.origin is https://localhost, so we also
          // rewrite those to the remote server.
          const passthroughPrefixes = ["/auth/", "/gateway/", "/healthz", "/assets/"]
          const originalFetch = globalThis.fetch.bind(globalThis)
          globalThis.fetch = async (input, init) => {
            let url: URL | undefined
            if (typeof input === "string") {
              url = new URL(input, location.origin)
            } else if (input instanceof URL) {
              url = new URL(input)
            } else if (input instanceof Request) {
              url = new URL(input.url)
            }
            if (url && (url.origin === location.origin || url.origin === serverOrigin)) {
              if (passthroughPrefixes.some(p => url!.pathname.startsWith(p))) {
                // Passthrough paths go to the server but without session prefix
                if (url.origin === location.origin && serverOrigin !== location.origin) {
                  url = new URL(url.pathname + url.search + url.hash, serverOrigin)
                }
              } else if (!url.pathname.startsWith(sessionPrefix)) {
                // All other paths get the session prefix and target the server
                url = new URL(`${sessionPrefix}${url.pathname}${url.search}${url.hash}`, serverOrigin)
              } else if (url.origin === location.origin && serverOrigin !== location.origin) {
                // Already has session prefix but wrong origin (mobile)
                url = new URL(url.pathname + url.search + url.hash, serverOrigin)
              }
              if (input instanceof Request) {
                // Uint8Array, not ArrayBuffer: CapacitorHttp on Android sends ArrayBuffer bodies as empty
                const body = input.method !== "GET" && input.method !== "HEAD"
                  ? new Uint8Array(await input.arrayBuffer())
                  : undefined
                return originalFetch(url.toString(), {
                  method: input.method,
                  headers: input.headers,
                  body,
                  credentials: input.credentials,
                  redirect: input.redirect,
                  signal: input.signal,
                  ...init,
                }).then(dropBogusContentLength)
              }
              return originalFetch(url, init).then(dropBogusContentLength)
            }
            return originalFetch(input, init)
          }

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
  loadConfig().then(() => render(() => <App />, root))
}
