# Mobile Sign-In in the System Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mobile app signs in through the system authentication browser (iOS `ASWebAuthenticationSession`, Android Custom Tabs) and its WebView loads nothing but the bundled app.

**Architecture:** A local Capacitor plugin `SystemAuth` opens `<api>/auth/start?return_to=com.opencode.rc:/auth/done` in the system browser and resolves with the callback URL the API redirects to. The UI exchanges the `#code` from that URL with its in-memory verifier at `/auth/token`. The API accepts exactly that callback as `return_to` and 302s to it; `allowNavigation` becomes `[]`.

**Tech Stack:** Hono/Bun API (vitest), SolidJS UI (vitest + @solidjs/testing-library), Capacitor 8 (Swift, Java), androidx.browser Custom Tabs.

**Spec:** `docs/superpowers/specs/2026-09-26-system-browser-login-design.md`

## Global Constraints

- Callback URL: `com.opencode.rc:/auth/done`; callback scheme: `com.opencode.rc` (fixed, not configurable).
- Browser session shared with the device browser: `prefersEphemeralWebBrowserSession = false`.
- Plugin rejections use `code: "cancelled"` or `code: "failed"`.
- `allowNavigation: []`; mobile `config.json` carries only `serverUrl`.
- The web UI sign-in flow (full-page redirect, `#code`, `completeLogin()`) does not change.
- Package managers: `api/`, `ui/` use bun (tests via `npx vitest run`); never npm install there.
- Commits: `<type>: <description>`, no attribution lines, no mention of Claude.
- Never write private hostnames, usernames or IPs into committed files.

---

### Task 1: API accepts the app callback as return_to

**Files:**
- Modify: `api/src/origins.ts`
- Modify: `api/src/auth.ts` (the `/auth/callback` return statement)
- Test: `api/src/origins.test.ts`, `api/src/auth.test.ts`

**Interfaces:**
- Produces: `export const APP_CALLBACK = "com.opencode.rc:/auth/done"` in `api/src/origins.ts`.
- `validateReturnTo(returnTo, isAllowed)` returns `APP_CALLBACK` for exactly that input, and `null` for absolute URLs whose origin is in `APP_ORIGINS` (they stay allowed for CORS via `makeOriginCheck`).

- [ ] **Step 1: Update the origins tests**

In `api/src/origins.test.ts`, change the import to include `APP_CALLBACK`:

```ts
import { originOf, makeOriginCheck, validateReturnTo, corsMiddleware, APP_CALLBACK } from "./origins.js";
```

Replace the test `"accepts allowed absolute URLs"` and add two tests after `"rejects other absolute URLs"`:

```ts
  it("accepts allowed absolute URLs", () => {
    expect(validateReturnTo("https://dev.example.com/", isAllowed)).toBe("https://dev.example.com/");
    expect(validateReturnTo("https://dev.example.com/s/x/#y", isAllowed)).toBe("https://dev.example.com/s/x/");
  });
```

```ts
  it("accepts exactly the mobile app callback", () => {
    expect(APP_CALLBACK).toBe("com.opencode.rc:/auth/done");
    expect(validateReturnTo("com.opencode.rc:/auth/done", isAllowed)).toBe("com.opencode.rc:/auth/done");
    for (const bad of [
      "com.opencode.rc:/auth/done/x",
      "com.opencode.rc:/auth/done?x=1",
      "com.opencode.rc:/auth/done#x",
      "com.opencode.rc://auth/done",
      "com.opencode.rcx:/auth/done",
      "COM.OPENCODE.RC:/auth/done",
      "other.app:/auth/done",
    ]) {
      expect(validateReturnTo(bad, isAllowed)).toBeNull();
    }
  });

  it("no longer accepts the app's WebView origins as return_to", () => {
    expect(validateReturnTo("capacitor://localhost/", isAllowed)).toBeNull();
    expect(validateReturnTo("https://localhost/s/x/", isAllowed)).toBeNull();
    // They stay allowed for CORS.
    expect(isAllowed("capacitor://localhost")).toBe(true);
    expect(isAllowed("https://localhost")).toBe(true);
  });
```

- [ ] **Step 2: Update the auth route tests**

In `api/src/auth.test.ts`, `/auth/start` test `"redirects to the IdP and stores state, return_to and the code challenge"`: use the app callback.

```ts
  it("redirects to the IdP and stores state, return_to and the code challenge", async () => {
    const res = await app.request(
      `/auth/start?return_to=com.opencode.rc%3A%2Fauth%2Fdone&code_challenge=${challenge}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/idp\.example\.com\/authorize\?/);
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toContain("orc_state=");
    expect(cookies).toContain("orc_return=com.opencode.rc%3A%2Fauth%2Fdone");
    expect(cookies).toMatch(new RegExp(`orc_challenge=${challenge}; Max-Age=300; Path=/auth; HttpOnly`));
  });

  it("rejects the old WebView return_to", async () => {
    const res = await app.request(
      `/auth/start?return_to=https%3A%2F%2Flocalhost%2F&code_challenge=${challenge}`,
    );
    expect(res.status).toBe(400);
  });
```

In `describe("/auth/callback")`, the app under test uses `makeOriginCheck("https://rc.example.com", [])`, so the only allowed absolute origin is `https://rc.example.com`. Replace the tests `"returns to the mobile app with a script navigation instead of a redirect"` and `"escapes < in the script navigation target"` with:

```ts
  it("redirects to the mobile app callback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    const res = await callback(
      `orc_state=st; orc_return=com.opencode.rc%3A%2Fauth%2Fdone; orc_challenge=${challenge}`,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^com\.opencode\.rc:\/auth\/done#code=/);
    const code = decodeURIComponent(location.split("#code=")[1]);
    const ok = await post("/auth/token", { code, code_verifier: verifier });
    expect(ok.status).toBe(200);
  });

  it("returns to an absolute web origin with a script navigation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    const res = await callback(
      `orc_state=st; orc_return=https%3A%2F%2Frc.example.com%2Fs%2Fx%2F; orc_challenge=${challenge}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toMatch(/location\.replace\("https:\/\/rc\.example\.com\/s\/x\/#code=[^"]+"\)/);
  });

  it("escapes < in the script navigation target", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    const returnTo = encodeURIComponent("https://rc.example.com/?x=</script><script>alert(1)");
    const res = await callback(`orc_state=st; orc_return=${returnTo}; orc_challenge=${challenge}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("</script><script>alert");
    expect(html).toContain("\\u003c/script>");
  });
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd api && npx vitest run src/origins.test.ts src/auth.test.ts`
Expected: FAIL (`APP_CALLBACK` not exported; app callback rejected; `https://localhost` still accepted).

- [ ] **Step 4: Implement**

In `api/src/origins.ts`, below `APP_ORIGINS`:

```ts
// The mobile app's sign-in callback (RFC 8252 private-use scheme). The system browser
// hands it to the app; the login code in its fragment is useless without the app's verifier.
export const APP_CALLBACK = "com.opencode.rc:/auth/done";
```

In `validateReturnTo`, right after `if (hasUnsafeChars(returnTo)) return null;` add:

```ts
  if (returnTo === APP_CALLBACK) return APP_CALLBACK;
```

and replace the tail of the function:

```ts
  const origin = originOf(withoutFragment);
  if (!origin || !isAllowed(origin)) return null;
  return withoutFragment;
```

with:

```ts
  const origin = originOf(withoutFragment);
  // The app signs in through the system browser now; its WebView origins stay allowed for CORS only.
  if (!origin || APP_ORIGINS.includes(origin) || !isAllowed(origin)) return null;
  return withoutFragment;
```

In `api/src/auth.ts`, import `APP_CALLBACK` from `./origins.js` (extend the existing import of `validateReturnTo`), and replace the end of the `/auth/callback` handler:

```ts
    const target = `${returnTo}#code=${encodeURIComponent(loginCode)}`;
    // Same-origin paths use a normal redirect. Absolute targets (the mobile app's
    // https://localhost or capacitor://localhost) get a script navigation instead:
    // Android WebView does not route a server redirect to the app's local origin
    // through Capacitor, but it does route a script-initiated navigation.
    return returnTo.startsWith("/") ? c.redirect(target) : scriptRedirect(c, target);
```

with:

```ts
    const target = `${returnTo}#code=${encodeURIComponent(loginCode)}`;
    // Paths and the app callback (followed by the system browser) use a normal redirect.
    // Absolute web origins (the UI host) get a script navigation, which keeps the code
    // fragment out of the Location header.
    return returnTo.startsWith("/") || returnTo === APP_CALLBACK
      ? c.redirect(target)
      : scriptRedirect(c, target);
```

- [ ] **Step 5: Run the API tests**

Run: `cd api && npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add api/src/origins.ts api/src/origins.test.ts api/src/auth.ts api/src/auth.test.ts
git commit -m "feat(api): accept the mobile app's system-browser callback as return_to"
```

---

### Task 2: Empty WebView allowlist, config.json back to serverUrl only

**Files:**
- Delete: `ui/src/nav-allowlist.ts`, `ui/src/nav-allowlist.test.ts`
- Modify: `ui/src/server.ts`, `ui/src/api.test.ts`, `ui/src/config-screen.tsx`, `ui/capacitor.config.ts`
- Modify: `docs/ios-app.md`, `AGENTS.md`

**Interfaces:**
- Removes `deriveAllowNavigation`, `hostAllowed`, `AppConfig` and `navigationAllowlist()`; nothing later uses them.

- [ ] **Step 1: Remove the derivation**

Delete `ui/src/nav-allowlist.ts` and `ui/src/nav-allowlist.test.ts`.

In `ui/src/server.ts` remove the `import { deriveAllowNavigation } from "./nav-allowlist"` line, the `let allowNavigation: string[] = []` line, the `allowNavigation = deriveAllowNavigation(config)` line in `loadConfig`, the `allowNavigation = []` line in `resetConfig`, and the whole `navigationAllowlist()` function with its comment.

In `ui/src/api.test.ts` remove `navigationAllowlist` from the import and delete the test `"derives the navigation allowlist from serverUrl and the OIDC issuer"`.

In `ui/src/config-screen.tsx`:
- imports become:
  ```tsx
  import { type Component, createSignal } from "solid-js"
  import { getBaseUrl, setBaseUrl } from "./api"
  ```
- replace the URL check block (from `let host: string` through the closing brace of the `Capacitor.isNativePlatform()` check) with the original:
  ```tsx
    try {
      new URL(value)
    } catch {
      setError("Invalid URL")
      return
    }
  ```

Replace `ui/capacitor.config.ts` with:

```ts
import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "com.opencode.rc",
  appName: "OpenCode RC",
  webDir: "dist",
  server: {
    androidScheme: "https",
    // The WebView only shows the bundled app: sign-in runs in the system browser
    // (SystemAuth plugin) and every other link opens there too.
    allowNavigation: [],
  },
}

export default config
```

(`ui/ios/App/App/capacitor.config.json` already has `"allowNavigation": []`; leave it.)

- [ ] **Step 2: Run the UI tests and type-check the touched files**

Run: `cd ui && npx vitest run`
Expected: all pass. Run `grep -rn "nav-allowlist\|navigationAllowlist\|deriveAllowNavigation" ui/src ui/capacitor.config.ts` — expected: no output.

- [ ] **Step 3: Update the docs**

In `docs/ios-app.md`, replace the whole `## Build-Time config.json` section (up to, not including, `## Docker Image as Transport`) with:

```markdown
## Sign-In and Navigation

The app signs in through the system browser (`ASWebAuthenticationSession` on iOS,
Custom Tabs on Android), not in its WebView: it opens
`<api>/auth/start?return_to=com.opencode.rc:/auth/done`, the IdP may use any hosts,
and the API finally redirects to `com.opencode.rc:/auth/done#code=…`, which the
system hands back to the app. The app exchanges the code together with its
verifier for tokens, so a code captured by another app is useless.

The WebView loads only the bundled app (`allowNavigation: []`); every other link
opens in Safari (Android: the default browser). API calls (`fetch`, WebSockets)
are not navigations and are not affected.

## Build-Time config.json

To preset the server, write `config.json` into `ui/dist/` after `bun run build` and
before `npx cap sync`:

```json
{ "serverUrl": "https://rc.corp.example.com" }
```

Users then never see the server settings screen.

```

Also in `docs/ios-app.md`, in the "Architecture" section replace the paragraph starting `Login runs inside the WebView:` (through `(stored in \`localStorage\`, valid 7 days).`) with:

```markdown
Login runs in the system browser (see "Sign-In and Navigation"); the app then
holds an access token (15 min) and a refresh token (stored in `localStorage`,
valid 7 days).
```

In `AGENTS.md`, replace the paragraph starting `For the iOS/Android apps, write \`dist/config.json\`` with:

```markdown
The iOS/Android apps sign in through the system browser (local `SystemAuth` plugin, callback
`com.opencode.rc:/auth/done`) and their WebView loads only the bundled app. To preset the server,
write `dist/config.json` (`{"serverUrl": …}`) before `npx cap sync` (see `docs/ios-app.md`).
```

- [ ] **Step 4: Commit**

```bash
git add -A ui/src ui/capacitor.config.ts docs/ios-app.md AGENTS.md
git commit -m "refactor(ui): WebView loads only the bundled app; drop the derived allowlist"
```

---

### Task 3: UI native sign-in through SystemAuth

**Files:**
- Create: `ui/src/system-auth.ts`
- Modify: `ui/src/auth.ts`, `ui/src/login-screen.tsx`, `ui/src/entry.tsx`
- Test: `ui/src/auth-native.test.ts` (new), `ui/src/login-screen.test.tsx`

**Interfaces:**
- Consumes: API contract from Task 1 (`return_to=com.opencode.rc:/auth/done`, callback `com.opencode.rc:/auth/done#code=<code>`).
- Produces (JS side of the native plugin, implemented natively in Tasks 4-5):
  ```ts
  // ui/src/system-auth.ts
  export interface SystemAuthPlugin {
    start(options: { url: string; callbackScheme: string }): Promise<{ url: string }>
  }
  export const SystemAuth: SystemAuthPlugin // registerPlugin<SystemAuthPlugin>("SystemAuth")
  ```
- `ui/src/auth.ts` exports `APP_CALLBACK_SCHEME = "com.opencode.rc"`, `APP_CALLBACK = "com.opencode.rc:/auth/done"`, `type LoginResult = "redirected" | "ok" | "cancelled" | "failed"`, and `login(): Promise<LoginResult>`.
- `LoginScreen` gains `onLoggedIn?: () => void`.

- [ ] **Step 1: Create the plugin wrapper**

`ui/src/system-auth.ts`:

```ts
import { registerPlugin } from "@capacitor/core"

// Native sign-in browser (ASWebAuthenticationSession / Custom Tabs); see
// ui/ios/App/App/SystemAuthPlugin.swift and ui/android/.../SystemAuthPlugin.java.
// Rejections carry code "cancelled" (user closed it) or "failed".
export interface SystemAuthPlugin {
  start(options: { url: string; callbackScheme: string }): Promise<{ url: string }>
}

export const SystemAuth = registerPlugin<SystemAuthPlugin>("SystemAuth")
```

- [ ] **Step 2: Write the failing native login tests**

`ui/src/auth-native.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

const start = vi.fn()
vi.mock("./system-auth", () => ({ SystemAuth: { start } }))
vi.mock("@capacitor/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@capacitor/core")>()),
  Capacitor: { isNativePlatform: () => true },
}))

import { APP_CALLBACK, REFRESH_KEY, login, resetAuthState } from "./auth"
import { resetConfig } from "./server"

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetConfig()
  resetAuthState()
  start.mockReset()
  localStorage.setItem("opencode-rc-endpoint", "https://rc.example.com")
})

afterEach(() => vi.restoreAllMocks())

describe("native login", () => {
  it("signs in through the system browser and exchanges the code with the verifier", async () => {
    start.mockResolvedValue({ url: `${APP_CALLBACK}#code=abc%2B1` })
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ access_token: "a", refresh_token: "r", expires_in: 900 }))

    expect(await login()).toBe("ok")

    const { url, callbackScheme } = start.mock.calls[0][0]
    expect(callbackScheme).toBe("com.opencode.rc")
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe("https://rc.example.com/auth/start")
    expect(u.searchParams.get("return_to")).toBe("com.opencode.rc:/auth/done")
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const [tokenUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(tokenUrl).toBe("https://rc.example.com/auth/token")
    const body = JSON.parse(init.body as string)
    expect(body.code).toBe("abc+1")
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(localStorage.getItem(REFRESH_KEY)).toBe("r")
    // The verifier never leaves the app, not even into storage.
    expect(sessionStorage.length).toBe(0)
  })

  it("reports cancelled when the user closes the browser", async () => {
    start.mockRejectedValue(Object.assign(new Error("closed"), { code: "cancelled" }))
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    expect(await login()).toBe("cancelled")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("reports failed on a plugin error", async () => {
    start.mockRejectedValue(Object.assign(new Error("boom"), { code: "failed" }))
    expect(await login()).toBe("failed")
  })

  it("reports failed when the callback has no code", async () => {
    start.mockResolvedValue({ url: `${APP_CALLBACK}#error=access_denied` })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    expect(await login()).toBe("failed")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("reports failed when the code exchange is rejected", async () => {
    start.mockResolvedValue({ url: `${APP_CALLBACK}#code=abc` })
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "invalid_grant" }, 400))
    expect(await login()).toBe("failed")
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull()
  })

  it("reports failed without a configured server", async () => {
    localStorage.removeItem("opencode-rc-endpoint")
    expect(await login()).toBe("failed")
    expect(start).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run and confirm failure**

Run: `cd ui && npx vitest run src/auth-native.test.ts`
Expected: FAIL (`APP_CALLBACK` not exported; `login()` navigates instead of calling the plugin).

- [ ] **Step 4: Implement native login in `ui/src/auth.ts`**

Add imports at the top:

```ts
import { Capacitor } from "@capacitor/core"
import { SystemAuth } from "./system-auth"
```

Add below the existing constants (`EARLY_REFRESH_MS`):

```ts
// The mobile app's sign-in callback; must match APP_CALLBACK in api/src/origins.ts.
export const APP_CALLBACK_SCHEME = "com.opencode.rc"
export const APP_CALLBACK = `${APP_CALLBACK_SCHEME}:/auth/done`

export type LoginResult = "redirected" | "ok" | "cancelled" | "failed"
```

Replace `login()` and `completeLogin()` with:

```ts
function codeFromFragment(url: string): string | null {
  const match = url.match(/#(?:.*&)?code=([^&]+)/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

async function exchangeCode(code: string, verifier: string): Promise<boolean> {
  try {
    const res = await postJson("/auth/token", { code, code_verifier: verifier })
    if (!res.ok) return false
    save((await res.json()) as TokenResponse)
    return true
  } catch {
    return false
  }
}

// Native apps sign in through the system browser (RFC 8252): the WebView never leaves
// the app, so the verifier stays in memory.
async function nativeLogin(verifier: string, challenge: string): Promise<LoginResult> {
  if (!getBaseUrl()) return "failed"
  let callback: string
  try {
    const result = await SystemAuth.start({
      url: apiUrl(`/auth/start?return_to=${encodeURIComponent(APP_CALLBACK)}&code_challenge=${challenge}`),
      callbackScheme: APP_CALLBACK_SCHEME,
    })
    callback = result.url
  } catch (err) {
    return (err as { code?: string } | null)?.code === "cancelled" ? "cancelled" : "failed"
  }
  const code = codeFromFragment(callback)
  if (!code) return "failed"
  return (await exchangeCode(code, verifier)) ? "ok" : "failed"
}

export async function login(): Promise<LoginResult> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = await codeChallenge(verifier)
  if (Capacitor.isNativePlatform()) return nativeLogin(verifier, challenge)

  saveVerifier(verifier)
  // Served by the server itself: return to a path. Otherwise (separate UI host): absolute URL.
  const returnTo = getBaseUrl()
    ? window.location.href.split("#")[0]
    : window.location.pathname + window.location.search
  window.location.href = apiUrl(
    `/auth/start?return_to=${encodeURIComponent(returnTo)}&code_challenge=${challenge}`,
  )
  return "redirected"
}

export async function completeLogin(): Promise<"none" | "ok" | "expired"> {
  const match = window.location.hash.match(/(?:^#|&)code=([^&]+)/)
  if (!match) return "none"
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search)
  const verifier = takeVerifier()
  if (!verifier) return "expired"
  let code: string
  try {
    code = decodeURIComponent(match[1])
  } catch {
    return "expired"
  }
  return (await exchangeCode(code, verifier)) ? "ok" : "expired"
}
```

Note: the web `login()` previously saved the verifier before computing the challenge; keep the order shown (compute first, save only on the web path) — the existing web tests only check that the saved verifier matches the challenge.

- [ ] **Step 5: Run the auth tests**

Run: `cd ui && npx vitest run src/auth-native.test.ts src/auth.test.ts`
Expected: all pass (web tests unchanged, since jsdom is not a native platform).

- [ ] **Step 6: Wire the login screen**

Add to `ui/src/login-screen.test.tsx` (at the top-level `describe("LoginScreen")`), plus `import * as auth from "./auth"` at the top:

```tsx
  it("calls onLoggedIn after a successful native sign-in", async () => {
    vi.spyOn(auth, "login").mockResolvedValue("ok")
    const onLoggedIn = vi.fn()
    render(() => <LoginScreen onSettings={vi.fn()} onLoggedIn={onLoggedIn} />)
    await fireEvent.click(screen.getByText("Sign in with OIDC"))
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledOnce())
    expect(screen.queryByText("Sign-in failed, try again")).toBeNull()
  })

  it("shows an error when sign-in fails", async () => {
    vi.spyOn(auth, "login").mockResolvedValue("failed")
    render(() => <LoginScreen onSettings={vi.fn()} />)
    await fireEvent.click(screen.getByText("Sign in with OIDC"))
    await vi.waitFor(() => expect(screen.getByText("Sign-in failed, try again")).toBeTruthy())
  })

  it("stays quiet when sign-in is cancelled", async () => {
    vi.spyOn(auth, "login").mockResolvedValue("cancelled")
    const onLoggedIn = vi.fn()
    render(() => <LoginScreen onSettings={vi.fn()} onLoggedIn={onLoggedIn} />)
    await fireEvent.click(screen.getByText("Sign in with OIDC"))
    await Promise.resolve()
    expect(onLoggedIn).not.toHaveBeenCalled()
    expect(screen.queryByText("Sign-in failed, try again")).toBeNull()
  })
```

If `vi.spyOn(auth, "login")` cannot redefine the ESM export, switch the file to `vi.mock("./auth", async (orig) => ({ ...(await orig<typeof import("./auth")>()), login: vi.fn() }))` and set `vi.mocked(login).mockResolvedValue(...)` per test (the existing redirect tests then need `vi.mocked(login).mockImplementation(...)` to call through to the original; prefer the spy if it works).

Run: `cd ui && npx vitest run src/login-screen.test.tsx` — expected: the three new tests FAIL.

In `ui/src/login-screen.tsx`:
- imports: `import { type Component, Show, createSignal } from "solid-js"`
- props type: `Component<{ onSettings: () => void; onLoggedIn?: () => void; expired?: boolean }>`
- at the top of the component body:
  ```tsx
  const [failed, setFailed] = createSignal(false)
  const signIn = async () => {
    setFailed(false)
    const result = await login()
    if (result === "ok") props.onLoggedIn?.()
    else if (result === "failed") setFailed(true)
  }
  ```
- after the `expired` `<Show>` block add:
  ```tsx
        <Show when={failed()}>
          <p class="text-13-regular text-red-500 mb-4">Sign-in failed, try again</p>
        </Show>
  ```
- the button: `onClick={() => void signIn()}`

In `ui/src/entry.tsx`, pass the refetch to the login screen:

```tsx
        <LoginScreen onSettings={() => setShowConfig(true)} onLoggedIn={() => refetchUser()} expired={props.loginExpired} />
```

- [ ] **Step 7: Run all UI tests**

Run: `cd ui && npx vitest run`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add ui/src/system-auth.ts ui/src/auth.ts ui/src/auth-native.test.ts ui/src/login-screen.tsx ui/src/login-screen.test.tsx ui/src/entry.tsx
git commit -m "feat(ui): native sign-in through the SystemAuth system browser"
```

---

### Task 4: Android SystemAuth plugin (Custom Tabs)

**Files:**
- Create: `ui/android/app/src/main/java/com/opencode/rc/SystemAuthPlugin.java`
- Modify: `ui/android/app/src/main/java/com/opencode/rc/MainActivity.java`
- Modify: `ui/android/app/src/main/AndroidManifest.xml`
- Modify: `ui/android/app/build.gradle`, `ui/android/variables.gradle`

**Interfaces:**
- Consumes: JS contract from Task 3 — plugin name `SystemAuth`, method `start({ url, callbackScheme })` resolving `{ url }`, rejecting with code `cancelled` / `failed`.

- [ ] **Step 1: Add the Custom Tabs dependency**

`ui/android/variables.gradle`, inside `ext { … }` add: `androidxBrowserVersion = '1.8.0'`

`ui/android/app/build.gradle`, in `dependencies { … }` after the appcompat line add:

```gradle
    implementation "androidx.browser:browser:$androidxBrowserVersion"
```

- [ ] **Step 2: Create the plugin**

`ui/android/app/src/main/java/com/opencode/rc/SystemAuthPlugin.java`:

```java
package com.opencode.rc;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Signs in through a Custom Tab (RFC 8252). The API redirects to the app's callback
 * scheme, which MainActivity receives as a new intent (see AndroidManifest.xml).
 */
@CapacitorPlugin(name = "SystemAuth")
public class SystemAuthPlugin extends Plugin {

    private PluginCall pending;
    private String callbackScheme;

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        String scheme = call.getString("callbackScheme");
        if (url == null || scheme == null || scheme.isEmpty()) {
            call.reject("url and callbackScheme are required", "failed");
            return;
        }
        if (pending != null) {
            pending.reject("superseded by a new sign-in", "cancelled");
        }
        pending = call;
        callbackScheme = scheme;
        try {
            new CustomTabsIntent.Builder().build().launchUrl(getActivity(), Uri.parse(url));
        } catch (ActivityNotFoundException e) {
            pending = null;
            call.reject("no browser available", "failed");
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        Uri data = intent.getData();
        if (pending == null || data == null || !callbackScheme.equalsIgnoreCase(data.getScheme())) {
            return;
        }
        JSObject result = new JSObject();
        result.put("url", data.toString());
        PluginCall call = pending;
        pending = null;
        call.resolve(result);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        // Back in the app without a callback (onNewIntent runs before onResume): the user closed the tab.
        if (pending != null) {
            PluginCall call = pending;
            pending = null;
            call.reject("sign-in cancelled", "cancelled");
        }
    }
}
```

- [ ] **Step 3: Register the plugin and the callback scheme**

`MainActivity.java`, at the start of `onCreate` (before `super.onCreate`):

```java
        registerPlugin(SystemAuthPlugin.class);
```

`AndroidManifest.xml`, inside the `MainActivity` `<activity>` (it is already `launchMode="singleTask"`), after the launcher `<intent-filter>`:

```xml
            <!-- Sign-in callback from the system browser (SystemAuthPlugin). -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="com.opencode.rc" />
            </intent-filter>
```

- [ ] **Step 4: Build**

Run:
```bash
cd ui && bun run build && npx cap sync android
cd android && JAVA_HOME=~/.local/share/mise/installs/java/21.0.2 ANDROID_HOME=~/Android/Sdk ./gradlew assembleDebug
```
Expected: `BUILD SUCCESSFUL`, APK at `ui/android/app/build/outputs/apk/debug/app-debug.apk`.

(`handleOnResume` / `handleOnNewIntent` are `protected` hooks on `com.getcapacitor.Plugin`; if the compiler reports a different signature, check `ui/node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/Plugin.java` and match it.)

- [ ] **Step 5: Commit**

```bash
git add ui/android/app/src/main/java/com/opencode/rc/SystemAuthPlugin.java ui/android/app/src/main/java/com/opencode/rc/MainActivity.java ui/android/app/src/main/AndroidManifest.xml ui/android/app/build.gradle ui/android/variables.gradle
git commit -m "feat(android): SystemAuth plugin signs in through a Custom Tab"
```

Device verification (emulator against a deployment) is done by the controller after this task.

---

### Task 5: iOS SystemAuth plugin (ASWebAuthenticationSession)

**Files:**
- Create: `ui/ios/App/App/SystemAuthPlugin.swift`
- Modify: `ui/ios/App/App/SceneDelegate.swift` (register the plugin)
- Modify: `ui/ios/App/App.xcodeproj/project.pbxproj` (add the new file to the App target)

**Interfaces:**
- Consumes: same JS contract as Task 4.

- [ ] **Step 1: Create the plugin**

`ui/ios/App/App/SystemAuthPlugin.swift`:

```swift
import AuthenticationServices
import Capacitor

/// Signs in through ASWebAuthenticationSession (RFC 8252). The session captures the
/// redirect to the app's callback scheme itself, so no URL-scheme routing is needed.
@objc(SystemAuthPlugin)
public class SystemAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "SystemAuthPlugin"
    public let jsName = "SystemAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise)
    ]

    private var session: ASWebAuthenticationSession?
    private var pendingCall: CAPPluginCall?

    @objc func start(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString),
              let scheme = call.getString("callbackScheme"), !scheme.isEmpty else {
            call.reject("url and callbackScheme are required", "failed")
            return
        }
        DispatchQueue.main.async {
            if let previous = self.pendingCall {
                self.pendingCall = nil
                previous.reject("superseded by a new sign-in", "cancelled")
                self.session?.cancel()
            }
            self.pendingCall = call
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] callbackURL, error in
                guard let self = self, self.pendingCall === call else { return }
                self.pendingCall = nil
                self.session = nil
                if let callbackURL = callbackURL {
                    call.resolve(["url": callbackURL.absoluteString])
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    call.reject("sign-in cancelled", "cancelled")
                } else {
                    call.reject(error?.localizedDescription ?? "sign-in failed", "failed")
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.pendingCall = nil
                self.session = nil
                call.reject("could not start the sign-in session", "failed")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
```

- [ ] **Step 2: Register it**

In `ui/ios/App/App/SceneDelegate.swift`, inside `class SafeAreaViewController: CAPBridgeViewController`, add:

```swift
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SystemAuthPlugin())
    }
```

- [ ] **Step 3: Add the file to the Xcode target**

In `ui/ios/App/App.xcodeproj/project.pbxproj` add four entries, mirroring the existing `SceneDelegate.swift` entries (IDs `9582B6832FE993A70072D4E8` build file, `9582B6822FE993A50072D4E8` file reference):

1. `/* Begin PBXBuildFile section */`, next to the SceneDelegate line:
   ```
   		5A7E0C1D2FF0A10100C0FFEE /* SystemAuthPlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = 5A7E0C1C2FF0A10100C0FFEE /* SystemAuthPlugin.swift */; };
   ```
2. `/* Begin PBXFileReference section */`, next to the SceneDelegate line:
   ```
   		5A7E0C1C2FF0A10100C0FFEE /* SystemAuthPlugin.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = SystemAuthPlugin.swift; sourceTree = "<group>"; };
   ```
3. In the App group's `children = ( … )`, after `9582B6822FE993A50072D4E8 /* SceneDelegate.swift */,`:
   ```
   				5A7E0C1C2FF0A10100C0FFEE /* SystemAuthPlugin.swift */,
   ```
4. In the App target's `PBXSourcesBuildPhase` `files = ( … )`, after `9582B6832FE993A70072D4E8 /* SceneDelegate.swift in Sources */,`:
   ```
   				5A7E0C1D2FF0A10100C0FFEE /* SystemAuthPlugin.swift in Sources */,
   ```

Check both IDs are unique: `grep -c 5A7E0C1C2FF0A10100C0FFEE ui/ios/App/App.xcodeproj/project.pbxproj` → `3`; `grep -c 5A7E0C1D2FF0A10100C0FFEE …` → `2`.

- [ ] **Step 4: Commit**

```bash
git add ui/ios/App/App/SystemAuthPlugin.swift ui/ios/App/App/SceneDelegate.swift ui/ios/App/App.xcodeproj/project.pbxproj
git commit -m "feat(ios): SystemAuth plugin signs in through ASWebAuthenticationSession"
```

The build and simulator verification run on a Mac (Xcode 16.4) and are done by the controller after this task.

---

### Controller verification (not a subagent task)

1. `make unit-test` green.
2. Full e2e: `KUBE_CONTEXT=kind-<cluster> ./e2e/run.sh` green (web flow unchanged).
3. Deploy the API to a test deployment; Android emulator: sign in through the Custom Tab → back in the app logged in; close the tab → login screen, no error; an external link opens the browser. Spike check first: the Custom Tab follows the API's 302 to `com.opencode.rc:/auth/done` without a tap. If it does not, stop and re-plan (fallback: an HTML page on the API with a "Return to the app" link).
4. Copy the branch to the Mac, `bun run build && npx cap sync ios`, build for the simulator, and run the same three checks.
