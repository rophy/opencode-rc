// CapacitorHttp on Android reports `content-length: 0` for chunked responses that
// do carry a body. OpenCode's SDK client treats that header as an empty body and
// returns `{}`, so drop the header when the body turns out to be non-empty.
export async function dropBogusContentLength(res: Response): Promise<Response> {
  if (res.headers.get("content-length") !== "0") return res
  if (res.status < 200 || res.status >= 300 || res.status === 204 || res.status === 205) return res
  if (res.headers.get("content-type")?.includes("text/event-stream")) return res

  const body = await res.arrayBuffer()
  const headers = new Headers(res.headers)
  if (body.byteLength > 0) headers.delete("content-length")
  return new Response(body.byteLength > 0 ? body : null, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}
