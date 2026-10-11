import type { MiddlewareHandler } from "hono";
import { canonicalPath, proxyRest, type ProxyEnv } from "./proxy.js";

// opencode 1.x legacy routes (vendor/opencode-v1/packages/opencode/src/server/routes/instance/
// httpapi/groups) that opencode-rc refuses for every 1.x session, whatever the toggles. The 1.x
// UI never calls them, and each one acts outside what the toggles control:
const NEVER: { method: string | null; path: RegExp }[] = [
  // Applies any patch text to the working tree (git apply), so it writes files past uploads,
  // shell and config (instance.ts vcsApply).
  { method: "POST", path: /^\/vcs\/apply$/ },
  // Installs another opencode version on the machine (global.ts upgrade).
  { method: "POST", path: /^\/global\/upgrade$/ },
  // Drives a terminal UI on the machine: prompts, commands, toasts (tui.ts). null: any method.
  { method: null, path: /^\/tui(\/.*)?$/ },
  // Writes to the server's log (control.ts log).
  { method: "POST", path: /^\/log$/ },
  // Workspace sync between servers (sync.ts; replay is refused by uploads and downloads).
  { method: "POST", path: /^\/sync\/(start|steal|history)$/ },
  // Switches the machine's opencode console account (experimental.ts consoleSwitch).
  { method: "POST", path: /^\/experimental\/console\/switch$/ },
  // Workspace create, remove, warp and sync-list (workspace.ts); listing stays.
  { method: "POST", path: /^\/experimental\/workspace(\/.*)?$/ },
  { method: "DELETE", path: /^\/experimental\/workspace(\/.*)?$/ },
  // Moves a session between workspaces (control-plane.ts moveSession).
  { method: "POST", path: /^\/experimental\/control-plane\/move-session$/ },
];

export function v1NeverGuard(): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    const path = canonicalPath(proxyRest(c.req.path, c.req.param("sessionId")!));
    // Defensive: v1ApiGuard, earlier in v1Guards, already answers 400 for such a path.
    if (path === null) return c.text("unsupported characters in path", 400);
    const bare = path.replace(/\/+$/, "");
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    if (NEVER.some((r) => (r.method === null || r.method === method) && r.path.test(bare))) {
      console.log(`v1 guard: blocked user=${c.get("userId")} ${c.req.method} ${bare}`);
      return c.text("this opencode route is not available through opencode-rc", 403);
    }
    await next();
  };
}
