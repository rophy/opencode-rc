import { createEffect } from "solid-js"
import {
  AppBaseProviders,
  AppInterface,
  PlatformProvider,
  ServerConnection,
  useLayout,
  useServerSync,
  type Platform,
} from "@opencode-ai/app"
import "@opencode-ai/app/index.css"
import { getBaseUrl, type UserInfo } from "./api"
import { getAccessToken, getCachedAccessToken, invalidateAccessToken } from "./auth"
import { installProxyFetch, installProxyWebSocket } from "./proxy-fetch"
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
}
