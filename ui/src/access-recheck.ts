import type { UserInfo } from "./api"

// Asks /api/me again when a proxied request is refused, at most once per interval, and hands
// the answer on only when it ends the session view: access denied, or signed out (null). An
// error (server unreachable) or "still allowed" (a guard's 403) leaves the page as it is.
export function accessRecheck(
  fetchMe: () => Promise<UserInfo | null>,
  apply: (user: UserInfo | null) => void,
  intervalMs = 5000,
): () => void {
  let last = -Infinity
  return () => {
    const now = Date.now()
    if (now - last < intervalMs) return
    last = now
    fetchMe().then(
      (user) => {
        if (!user || user.allowed === false) apply(user)
      },
      () => {},
    )
  }
}
