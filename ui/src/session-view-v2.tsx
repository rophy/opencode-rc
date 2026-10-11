import { createEffect } from "solid-js"
import { AppBaseProviders, AppInterface, PlatformProvider, ServerConnection, type Platform } from "@opencode/app"
import { useGlobal } from "@opencode/app/desktop"
import "@opencode/app/index.css"
import { getBaseUrl, type UserInfo } from "./api"
import { getAccessToken, getCachedAccessToken, invalidateAccessToken } from "./auth"
import { installProxyFetch, installProxyWebSocket, installProxyXHR } from "./proxy-fetch"
import { UserBar } from "./user-bar"
import { BASE } from "./build-info"
import { createSessionRouter } from "./session-router"

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

// 2.x: projects are per-server state in the global runtime; AppInterface children render
// inside GlobalProvider.
function AutoOpenProjects(props: { server: ServerConnection.Any }) {
  const global = useGlobal()
  createEffect(() => {
    const ctx = global.ensureServerCtx(props.server)
    for (const project of ctx.sync.data.project) ctx.projects.open(project.worktree)
  })
  return null
}

export function SessionView(props: {
  sessionId: string
  user: UserInfo
  onSettings: () => void
  onForbidden: () => void
}) {
  const sessionId = props.sessionId
  const sessionPrefix = `${BASE}/s/${sessionId}`
  const serverOrigin = getBaseUrl() || location.origin
  const proxyUrl = `${serverOrigin}/proxy/${sessionId}/`

  const proxyOpts = { pageOrigin: location.origin, serverOrigin, sessionId }
  installProxyFetch({
    ...proxyOpts,
    getToken: getAccessToken,
    invalidate: invalidateAccessToken,
    onForbidden: props.onForbidden,
  })
  installProxyXHR({ ...proxyOpts, getToken: getAccessToken, onForbidden: props.onForbidden })
  installProxyWebSocket({
    ...proxyOpts,
    getCachedToken: getCachedAccessToken,
    warmToken: () => void getAccessToken(),
    onForbidden: props.onForbidden,
  })

  const server: ServerConnection.Http = {
    type: "http",
    http: { url: proxyUrl },
  }
  const serverKey = ServerConnection.key(server)

  const SessionRouter = createSessionRouter(sessionPrefix)

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <div class="flex flex-col h-dvh">
          <UserBar user={props.user} onSettings={props.onSettings} />
          <div class="flex-1 min-h-0 flex flex-col">
            <AppInterface canonicalLocalServer={serverKey} servers={[server]} router={SessionRouter}>
              <AutoOpenProjects server={server} />
            </AppInterface>
          </div>
        </div>
      </AppBaseProviders>
    </PlatformProvider>
  )
}
