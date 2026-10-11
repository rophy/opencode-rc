// Test support: the HTTP routes an opencode checkout defines, read from its protocol package
// (packages/protocol/src/groups/*.ts, where every endpoint is an HttpApiEndpoint.<method>(name,
// path, ...) call). The route tables in v1-routes.ts and v2-routes.ts are checked against it.
import fs from "node:fs";
import path from "node:path";

const ENDPOINT = /HttpApiEndpoint\.(get|post|put|patch|delete)\(\s*"[^"]+",\s*(?:"([^"]*)"|`([^`]*)`|([A-Za-z_]\w*))/g;

export function protocolRoutes(opencodeRoot: string): { method: string; path: string }[] {
  const dir = path.join(opencodeRoot, "packages/protocol/src/groups");
  const out: { method: string; path: string }[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    const consts = Object.fromEntries([...source.matchAll(/const (\w+) = "([^"]+)"/g)].map((m) => [m[1], m[2]]));
    for (const m of source.matchAll(ENDPOINT)) {
      const raw = m[2] ?? m[3] ?? consts[m[4]];
      if (raw === undefined) throw new Error(`${file}: cannot resolve path ${m[4]}`);
      const resolved = raw.replace(/\$\{(\w+)\}/g, (_, name) => {
        if (!(name in consts)) throw new Error(`${file}: cannot resolve \${${name}}`);
        return consts[name];
      });
      out.push({ method: m[1].toUpperCase(), path: resolved });
    }
  }
  return out;
}
