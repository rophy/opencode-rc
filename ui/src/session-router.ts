import { delegateEvents } from "solid-js/web"
import { onCleanup } from "solid-js"
import { createRouter, createBeforeLeave, keepDepth, saveCurrentDepth, notifyIfNotBlocked } from "@solidjs/router"

export function createSessionRouter(sessionPrefix: string) {
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
  return createRouter({
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
}
