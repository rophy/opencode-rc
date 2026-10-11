// A route template as opencode writes it ("/api/session/:sessionID/prompt", "/api/fs/read/*")
// as a regex for canonical paths (see canonicalPath in proxy.ts: decoded and lower-case).
export function templateRegex(template: string): RegExp {
  const segments = template.toLowerCase().split("/").map((seg) => {
    if (seg === "*") return ".+";
    if (seg.startsWith(":")) return "[^/]+";
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${segments.join("/")}$`);
}
