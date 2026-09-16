import { render } from "solid-js/web"
import { createEffect, createResource, Match, Switch } from "solid-js"
import {
  AppBaseProviders,
  AppInterface,
  PlatformProvider,
  ServerConnection,
  useLayout,
  useServerSync,
  type Platform,
} from "@opencode-ai/app"
import { Router, type BaseRouterProps } from "@solidjs/router"
import "@opencode-ai/app/index.css"
import { fetchMe } from "./api"
import { UserBar } from "./user-bar"
import { SessionPicker } from "./session-picker"

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
  const [user] = createResource(fetchMe)
  const sessionId = getSessionIdFromPath()

  return (
    <Switch>
      <Match when={user.loading}>
        <div class="flex items-center justify-center h-dvh text-v2-text-tertiary">
          Loading...
        </div>
      </Match>
      <Match when={user.error || !user()}>
        {(() => {
          window.location.href = "/auth/login"
          return <div>Redirecting to login...</div>
        })()}
      </Match>
      <Match when={user() && !sessionId}>
        <UserBar user={user()!} />
        <SessionPicker user={user()!} />
      </Match>
      <Match when={user() && sessionId}>
        {(() => {
          const sessionPrefix = `/s/${sessionId}`
          const proxyUrl = `${location.origin}${sessionPrefix}/`

          // Patch globalThis.fetch to rewrite OpenCode API paths through the session proxy.
          // The SDK uses absolute paths ("/api/...", "/global/...", "/session/...", etc.)
          // in new URL(path, baseUrl), which strips the /s/{sessionId}/ prefix.
          // This intercept prepends the prefix for all same-origin requests that
          // aren't already under /s/, /auth/, /gateway/, or /healthz.
          const passthroughPrefixes = ["/s/", "/auth/", "/gateway/", "/healthz", "/assets/"]
          const originalFetch = globalThis.fetch.bind(globalThis)
          globalThis.fetch = (input, init) => {
            let url: URL | undefined
            if (typeof input === "string") {
              url = new URL(input, location.origin)
            } else if (input instanceof URL) {
              url = new URL(input)
            } else if (input instanceof Request) {
              url = new URL(input.url)
            }
            if (url && url.origin === location.origin && !passthroughPrefixes.some(p => url!.pathname.startsWith(p))) {
              url.pathname = `${sessionPrefix}${url.pathname}`
              if (input instanceof Request) {
                return originalFetch(new Request(url, input), init)
              }
              return originalFetch(url, init)
            }
            return originalFetch(input, init)
          }

          const server: ServerConnection.Http = {
            type: "http",
            http: { url: proxyUrl },
          }
          const serverKey = ServerConnection.key(server)

          const SessionRouter = (props: BaseRouterProps) => (
            <Router base={sessionPrefix} {...props} />
          )

          return (
            <PlatformProvider value={platform}>
              <AppBaseProviders>
                <div class="flex flex-col h-dvh">
                  <UserBar user={user()!} />
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
  render(() => <App />, root)
}
