// The same rule as the API's isV1Session: a missing or "1.*" version is opencode 1.x.
export function isV1Session(version?: string): boolean {
  return !version || /^1\./.test(version)
}

// Where a session is served: the 1.x build at /, the 2.x build at /v2. Origin-relative and
// independent of the build the link is rendered in.
export function sessionPath(session: { id: string; opencodeVersion?: string }): string {
  const prefix = isV1Session(session.opencodeVersion) ? "" : "/v2"
  return `${prefix}/s/${encodeURIComponent(session.id)}/`
}

// The URL to move to when the session belongs to the other build, else null.
// `base` is this build's BASE; `pathname` starts with `${base}/s/<encoded id>`.
export function mismatchRedirect(
  sessions: { id: string; opencodeVersion?: string }[],
  at: { base: string; id: string; pathname: string; search: string; hash: string },
): string | null {
  const session = sessions.find((s) => s.id === at.id)
  if (!session || isV1Session(session.opencodeVersion) === (at.base === "")) return null
  // The id is whatever the browser kept in the pathname (it leaves @ : $ raw), so match the
  // segment rather than re-encoding the id.
  const prefix = new RegExp(`^${at.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/s/[^/]+`)
  const rest = prefix.test(at.pathname) ? at.pathname.replace(prefix, "") : ""
  const tail = rest.startsWith("/") ? rest : "/" + rest
  return sessionPath(session) + tail.slice(1) + at.search + at.hash
}
