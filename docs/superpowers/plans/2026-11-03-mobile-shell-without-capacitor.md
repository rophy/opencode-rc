# Mobile Shell Without Capacitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Capacitor in the iOS and Android apps with plain native shells, send all iOS API traffic through URLSession, sign the apps in as a public OIDC client in the system browser view, and lock WebView navigation to the bundled UI.

**Architecture:** The API gets an app sign-in path (`/auth/app-config`, `/auth/app-token`) for a public client with PKCE. The UI gets a small bridge module (`native.ts`) and, on iOS, a transport layer (`native-transport.ts`) that maps server requests to `opencode-rc://localhost/__server/...` and WebSockets to the bridge. The iOS shell is UIKit + one WKWebView with a scheme handler that serves the bundle and forwards `/__server` with URLSession; the Android shell is an Activity + WebView with `WebViewAssetLoader` and a `WebMessageListener` bridge.

**Tech Stack:** TypeScript (Hono, Bun, vitest), SolidJS UI, Swift (UIKit, WebKit, SafariServices, XCTest), Java (Android, AndroidX webkit/browser, JUnit), Helm (helm-unittest), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-03-mobile-shell-without-capacitor-design.md`

## Global Constraints

- iOS origin: `opencode-rc://localhost`. Android origin: `https://localhost`. `APP_ORIGINS` = `["opencode-rc://localhost", "https://localhost"]`, no old names.
- App redirect URI: `com.opencode.rc:/auth/callback`. Callback scheme: `com.opencode.rc`.
- New API env var: `OIDC_APP_CLIENT_ID` (empty = app sign-in off; `/auth/app-config` and `/auth/app-token` answer 404).
- iOS server proxy path prefix: `/__server`.
- iOS: no third-party dependencies, deployment target iOS 15.0 (unchanged). Android: AndroidX libraries only (`org.json:json` allowed as a test-only dependency).
- No compatibility with the old origin, the old app sign-in path or Capacitor builds.
- No version bumps (iOS `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`, Android `versionName`/`versionCode`, API/UI/chart versions).
- Committed text (code, comments, docs, commit messages) must not name private hosts, IPs, `.local/` files, or the Mac build host; no AI attribution. Commits are GPG-signed automatically; never disable signing.
- Package managers: `bun` in `api/` and `ui/`; never `npm install` there.
- Before any push: `make unit-test` and Node 22 vitest (`npx -y node@22 node_modules/vitest/vitest.mjs run` in `api/` and `ui/`). Pushing needs the user's explicit instruction.
- iOS builds and tests run on the Mac build host (Xcode 16.4, `xcodeproj` Ruby gem installed): copy the worktree there, run `xcodebuild`, copy changed project files back. Use the simulator `iPhone 16 Pro`.

## File Structure

**API**
- `api/src/origins.ts` — app origins, `APP_REDIRECT_URI` (replaces `APP_CALLBACK`).
- `api/src/config.ts` — `oidcAppClientId`.
- `api/src/auth.ts` — `/auth/app-config`, `/auth/app-token`, `userFromIdToken`; app path removed from `/auth/start`.
- Tests: `api/src/auth.test.ts`, `api/src/origins.test.ts`, `api/src/config.test.ts`.

**Chart / e2e**
- `charts/opencode-rc/values.yaml`, `templates/_helpers.tpl`, `templates/api-deployment.yaml`, `templates/oidc-mock-configmap.yaml`, `tests/*`, `README.md`.
- `e2e/e2e.test.ts` — app sign-in test.

**UI**
- `ui/src/native.ts` (new) — bridge client: `nativePlatform`, `isNativeApp`, `nativeCall`, `nativeOn`, `NativeError`.
- `ui/src/native-transport.ts` (new) — iOS: request mapping, fetch/XHR/EventSource patches, `NativeWebSocket`.
- `ui/src/auth.ts` — app sign-in (public client + PKCE).
- `ui/src/protocol-screen.tsx`, `ui/src/entry.tsx` — use `native.ts`.
- `ui/src/system-auth.ts` — deleted.
- `ui/build/sync-mobile.ts` (new) — copies `dist` into the app projects; iOS CSP.
- `ui/package.json` — scripts; Capacitor packages removed.

**iOS (`ui/ios/App/`)**
- `App/AppDelegate.swift`, `App/SceneDelegate.swift`, `App/WebViewController.swift`, `App/AppSchemeHandler.swift`, `App/BundleFiles.swift`, `App/NavigationPolicy.swift`, `App/Bridge.swift`, `App/ServerProxy.swift`, `App/WebSocketBridge.swift`, `App/SignIn.swift`, `App/Info.plist`.
- `AppTests/` (new unit-test target): `BundleFilesTests.swift`, `NavigationPolicyTests.swift`, `BridgeTests.swift`, `ServerProxyTests.swift`, `SchemeHandlerWebViewTests.swift`, `WebSocketBridgeTests.swift`, `SignInTests.swift`.
- Removed: `App/SystemAuthPlugin.swift`, `App/capacitor.config.json`, `App/config.xml`, `CapApp-SPM/`, `../capacitor-cordova-ios-plugins/`, `../debug.xcconfig`.

**Android (`ui/android/`)**
- `app/src/main/java/com/opencode/rc/MainActivity.java`, `NavigationPolicy.java`, `BundlePaths.java`, `Bridge.java`, `SignIn.java`.
- `app/src/test/java/com/opencode/rc/NavigationPolicyTest.java`, `BundlePathsTest.java`, `BridgeTest.java`.
- Removed: `SystemAuthPlugin.java`, Capacitor Gradle files and modules, FileProvider.

**Tooling / CI / docs**
- `ui/ios-offline/bundle.sh`, `verify.sh`, `set-server-url.sh`, `set-server-url.test.ts`.
- `.github/workflows/ios.yml`, `ios-offline.yml`, `android.yml`.
- `AGENTS.md`, `README.md`, `docs/ios-app.md`, `ui/ios/README.md`, `ui/android/README.md`.

---

### Task 1: API app sign-in

**Files:**
- Modify: `api/src/origins.ts`, `api/src/config.ts`, `api/src/auth.ts`
- Test: `api/src/auth.test.ts`, `api/src/origins.test.ts`, `api/src/config.test.ts`

**Interfaces:**
- Produces: `GET /auth/app-config` → `200 { authorizationEndpoint: string, clientId: string, redirectUri: "com.opencode.rc:/auth/callback", prompt?: string }` or `404 { error: "not_found" }`.
- Produces: `POST /auth/app-token` (requires the `OpenCode-RC-Protocol` header) with JSON `{ code, code_verifier, nonce }` → `200 { access_token, refresh_token, expires_in }` | `400 { error: "invalid_grant" }` | `404` | `503 { error: "unavailable" }`.
- Produces: `APP_REDIRECT_URI` exported from `api/src/origins.ts`; `Config.oidcAppClientId: string`.

- [ ] **Step 1: Write the failing tests**

In `api/src/auth.test.ts`:
1. Add `oidcAppClientId: "",` to the `config` literal (after `oidcCliClientId`). Run `grep -rln "oidcCliClientId:" api/src` and add the same field to every other `Config` literal it finds.
2. Delete these tests (the app path of the web flow goes away): in `describe("/auth/start")`: "asks the IdP to prompt the user for app logins", "leaves web logins without a prompt", "sends no prompt when the app login prompt is disabled"; in `describe("/auth/callback")`: "redirects to the mobile app callback".
3. Add to `describe("/auth/start")`:

```ts
  it("rejects the old app callback as return_to", async () => {
    const res = await app.request(
      `/auth/start?return_to=${encodeURIComponent("com.opencode.rc:/auth/done")}&code_challenge=${challenge}`,
    );
    expect(res.status).toBe(400);
  });

  it("never sends a prompt", async () => {
    const res = await app.request(`/auth/start?return_to=%2F&code_challenge=${challenge}`);
    expect(new URL(res.headers.get("location")!).searchParams.has("prompt")).toBe(false);
  });
```

4. Add at the end of the file:

```ts
describe("app sign-in", () => {
  const appConfig: Config = { ...config, oidcAppClientId: "opencode-rc-app" };
  const useConfig = (cfg: Config) => {
    app = new Hono<AuthEnv>();
    app.route("/", authRoutes({ config: cfg, provider, tokens, isAllowedOrigin: () => false }));
    app.get("/protected", authMiddleware(cfg), (c) => c.json({ userId: c.get("userId") }));
  };
  const idClaims = { sub: "alice", email: "alice@example.com", name: "Alice", nonce: "n1" };

  it("GET /auth/app-config returns the public client", async () => {
    useConfig(appConfig);
    const res = await app.request("/auth/app-config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authorizationEndpoint: "https://idp.example.com/authorize",
      clientId: "opencode-rc-app",
      redirectUri: "com.opencode.rc:/auth/callback",
      prompt: "select_account",
    });
  });

  it("GET /auth/app-config omits prompt when it is disabled", async () => {
    useConfig({ ...appConfig, appLoginPrompt: "" });
    expect(await (await app.request("/auth/app-config")).json()).not.toHaveProperty("prompt");
  });

  it("answers 404 without an app client", async () => {
    useConfig(config);
    expect((await app.request("/auth/app-config")).status).toBe(404);
    expect((await post("/auth/app-token", { code: "c", code_verifier: "v", nonce: "n1" })).status).toBe(404);
  });

  it("exchanges the code as a public client and issues tokens", async () => {
    useConfig(appConfig);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    vi.mocked(verifyToken).mockResolvedValueOnce(idClaims);

    const res = await post("/auth/app-token", { code: "idp-code", code_verifier: verifier, nonce: "n1" });
    expect(res.status).toBe(200);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://idp.example.com/token");
    const form = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      client_id: "opencode-rc-app",
      code: "idp-code",
      code_verifier: verifier,
      redirect_uri: "com.opencode.rc:/auth/callback",
    });
    expect(verifyToken).toHaveBeenCalledWith(provider, "id", "opencode-rc-app");

    const body = await res.json();
    const me = await app.request("/protected", { headers: { authorization: `Bearer ${body.access_token}` } });
    expect(await me.json()).toEqual({ userId: "alice" });
    expect(body.refresh_token).toBeTruthy();
  });

  it("rejects a nonce mismatch", async () => {
    useConfig(appConfig);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    vi.mocked(verifyToken).mockResolvedValueOnce({ ...idClaims, nonce: "other" });
    const res = await post("/auth/app-token", { code: "c", code_verifier: verifier, nonce: "n1" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
  });

  it("rejects a failed code exchange", async () => {
    useConfig(appConfig);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
    expect((await post("/auth/app-token", { code: "c", code_verifier: verifier, nonce: "n1" })).status).toBe(400);
  });

  it("rejects an ID token that fails verification", async () => {
    useConfig(appConfig);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    vi.mocked(verifyToken).mockRejectedValueOnce(new Error("bad signature"));
    expect((await post("/auth/app-token", { code: "c", code_verifier: verifier, nonce: "n1" })).status).toBe(400);
  });

  it("rejects an ID token without the user claim", async () => {
    useConfig({ ...appConfig, oidcUserClaim: "oid" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    vi.mocked(verifyToken).mockResolvedValueOnce(idClaims);
    expect((await post("/auth/app-token", { code: "c", code_verifier: verifier, nonce: "n1" })).status).toBe(400);
  });

  it("rejects missing fields without calling the IdP", async () => {
    useConfig(appConfig);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const body of [{ code_verifier: verifier, nonce: "n1" }, { code: "c", nonce: "n1" }, { code: "c", code_verifier: verifier }])
      expect((await post("/auth/app-token", body)).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 503 when the IdP cannot be reached", async () => {
    useConfig(appConfig);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    expect((await post("/auth/app-token", { code: "c", code_verifier: verifier, nonce: "n1" })).status).toBe(503);
  });

  it("requires the protocol header", async () => {
    useConfig(appConfig);
    const res = await app.request("/auth/app-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "c", code_verifier: verifier, nonce: "n1" }),
    });
    expect(res.status).not.toBe(200);
  });
});
```

In `api/src/origins.test.ts`: replace every `capacitor://localhost` with `opencode-rc://localhost`, and change any test that expects `validateReturnTo("com.opencode.rc:/auth/done", ...)` to return the callback so it expects `null`. In `api/src/config.test.ts`: add a test that `OIDC_APP_CLIENT_ID=opencode-rc-app` gives `oidcAppClientId: "opencode-rc-app"` and that it defaults to `""` (follow the file's existing pattern for `OIDC_CLI_CLIENT_ID`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && bun run test -- auth.test.ts origins.test.ts config.test.ts`
Expected: FAIL (`/auth/app-config` 404 everywhere, `oidcAppClientId` missing, origin tests).

- [ ] **Step 3: Implement**

`api/src/origins.ts` — replace lines 4–8 and the `validateReturnTo` app case:

```ts
export const APP_ORIGINS: readonly string[] = ["opencode-rc://localhost", "https://localhost"];

// The mobile apps' sign-in redirect URI (RFC 8252 private-use scheme), registered at the IdP for
// the apps' public client. The system browser view hands it to the app.
export const APP_REDIRECT_URI = "com.opencode.rc:/auth/callback";
```

In `validateReturnTo`, delete the line `if (returnTo === APP_CALLBACK) return APP_CALLBACK;` and its comment, and change the comment above `if (!origin || APP_ORIGINS.includes(origin) ...)` to:

```ts
  // The apps' WebView origins are allowed for CORS only, never as a sign-in return target.
```

`api/src/config.ts` — in the `Config` interface after `oidcCliClientId`:

```ts
  /** Public OIDC client of the mobile apps ("" = app sign-in off) */
  oidcAppClientId: string;
```

and in the loader after `oidcCliClientId: ...`:

```ts
    oidcAppClientId: process.env.OIDC_APP_CLIENT_ID ?? "",
```

Update the `appLoginPrompt` doc comment to `/** OIDC prompt for mobile app sign-ins ("" = none); see appLoginPrompt() */` (unchanged meaning, now used by `/auth/app-config`).

`api/src/auth.ts`:
1. Import: `import { validateReturnTo, APP_REDIRECT_URI } from "./origins.js";`
2. In `/auth/start`, delete the line `if (returnTo === APP_CALLBACK && config.appLoginPrompt) params.set("prompt", config.appLoginPrompt);`.
3. Add above `authRoutes`:

```ts
// The user of a verified ID token; null when it lacks the configured user claim.
// Sessions are owned by an IdP-assigned ID; the email is only for display and logs.
function userFromIdToken(idClaims: Record<string, unknown>, userClaim: string): AccessClaims | null {
  const uid = idClaims[userClaim];
  if (typeof uid !== "string" || !uid) return null;
  return {
    uid,
    email: typeof idClaims.email === "string" ? idClaims.email : "",
    name: typeof idClaims.name === "string" ? idClaims.name : "",
  };
}
```

4. In `/auth/callback`, replace the block from `// Sessions are owned by ...` through the `claims` literal with:

```ts
    const claims = userFromIdToken(idClaims, config.oidcUserClaim);
    if (!claims) {
      console.error(`ID token has no ${config.oidcUserClaim} claim`);
      return c.text("invalid id_token", 401);
    }
```

5. Add after the `/auth/cli-config` route:

```ts
  // The mobile apps sign in as a public client with PKCE in the system browser view, which loads
  // only the IdP; the app then hands the code to /auth/app-token. Off without OIDC_APP_CLIENT_ID.
  app.get("/auth/app-config", (c) => {
    if (!config.oidcAppClientId) return c.json({ error: "not_found" }, 404);
    return c.json({
      authorizationEndpoint: provider.discovery.authorization_endpoint,
      clientId: config.oidcAppClientId,
      redirectUri: APP_REDIRECT_URI,
      ...(config.appLoginPrompt ? { prompt: config.appLoginPrompt } : {}),
    });
  });

  app.post("/auth/app-token", requireClientProtocol(), async (c) => {
    if (!config.oidcAppClientId) return c.json({ error: "not_found" }, 404);
    const body = await readBody(c);
    const code = stringField(body, "code");
    const verifier = stringField(body, "code_verifier");
    const nonce = stringField(body, "nonce");
    if (!code || !verifier || !nonce) return c.json({ error: "invalid_grant" }, 400);

    let tokenRes: Response;
    try {
      tokenRes = await fetch(provider.discovery.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.oidcAppClientId,
          code,
          code_verifier: verifier,
          redirect_uri: APP_REDIRECT_URI,
        }),
      });
    } catch (err) {
      console.error("app sign-in: token endpoint unreachable:", err);
      return c.json({ error: "unavailable" }, 503);
    }
    if (!tokenRes.ok) {
      console.error(`app sign-in: code exchange failed: ${tokenRes.status}`);
      return c.json({ error: "invalid_grant" }, 400);
    }
    const idToken = ((await tokenRes.json().catch(() => ({}))) as { id_token?: unknown }).id_token;
    if (typeof idToken !== "string" || !idToken) {
      console.error("app sign-in: no id_token in response");
      return c.json({ error: "invalid_grant" }, 400);
    }
    let idClaims: Record<string, unknown>;
    try {
      idClaims = (await verifyToken(provider, idToken, config.oidcAppClientId)) as typeof idClaims;
    } catch (err) {
      console.error("app sign-in: ID token verification failed:", err);
      return c.json({ error: "invalid_grant" }, 400);
    }
    if (idClaims.nonce !== nonce) {
      console.error("app sign-in: nonce mismatch");
      return c.json({ error: "invalid_grant" }, 400);
    }
    const claims = userFromIdToken(idClaims, config.oidcUserClaim);
    if (!claims) {
      console.error(`app sign-in: ID token has no ${config.oidcUserClaim} claim`);
      return c.json({ error: "invalid_grant" }, 400);
    }
    try {
      const session = await tokens.createChain(claims);
      console.log(`login: user=${claims.uid} email=${claims.email} name=${claims.name} client=app`);
      return tokenResponse(c, config, session.claims, session.refreshToken);
    } catch (err) {
      console.error("app sign-in: token store failed:", err);
      return c.json({ error: "unavailable" }, 503);
    }
  });
```

6. Run `grep -rn "APP_CALLBACK\|capacitor" api/src` and fix any remaining reference (none expected outside tests).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && bun run test && bun run typecheck`
Expected: all pass, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add api/src
git commit -m "feat(api): app sign-in as a public OIDC client with PKCE"
```

---

### Task 2: Chart and e2e for the app client

**Files:**
- Modify: `charts/opencode-rc/values.yaml`, `charts/opencode-rc/templates/_helpers.tpl`, `charts/opencode-rc/templates/api-deployment.yaml`, `charts/opencode-rc/templates/oidc-mock-configmap.yaml`, `charts/opencode-rc/README.md`
- Test: `charts/opencode-rc/tests/api_deployment_test.yaml`, `charts/opencode-rc/tests/oidc_mock_test.yaml`, `e2e/e2e.test.ts`

**Interfaces:**
- Consumes: `OIDC_APP_CLIENT_ID`, `/auth/app-config`, `/auth/app-token` (Task 1).
- Produces: values `oidc.appClientId` (default `""`) and `oidcMock.clients.app` (`id: opencode-rc-app`, `redirectUris: ["com.opencode.rc:/auth/callback"]`).

- [ ] **Step 1: Write the failing chart tests**

In `charts/opencode-rc/tests/api_deployment_test.yaml`, next to the existing `oidc.cliClientId: corp-cli` test, add (match the file's suite layout and `documentIndex`/`template` keys used there):

```yaml
  - it: sets OIDC_APP_CLIENT_ID from oidc.appClientId
    set:
      oidcMock.enabled: false
      oidc.issuer: https://idp.example.com
      oidc.appClientId: corp-app
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: OIDC_APP_CLIENT_ID
            value: corp-app
  - it: uses the mock's app client when the mock is enabled
    set:
      oidcMock.enabled: true
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: OIDC_APP_CLIENT_ID
            value: opencode-rc-app
  - it: leaves app sign-in off without an app client
    set:
      oidcMock.enabled: false
      oidc.issuer: https://idp.example.com
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: OIDC_APP_CLIENT_ID
            value: ""
```

In `charts/opencode-rc/tests/oidc_mock_test.yaml` add:

```yaml
  - it: registers the app's public client with its redirect URI
    set:
      oidcMock.enabled: true
    asserts:
      - matchRegex:
          path: data["oidc-config.yaml"]
          pattern: "- id: opencode-rc-app\\n\\s+redirect_uris:\\n\\s+- com.opencode.rc:/auth/callback"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `helm unittest charts/opencode-rc`
Expected: the 4 new tests FAIL.

- [ ] **Step 3: Implement the chart changes**

`values.yaml`, under `oidc:` after `cliClientId`:

```yaml
  # Public client of the mobile apps (PKCE, redirect URI com.opencode.rc:/auth/callback).
  # Empty: oidcMock.clients.app.id when the mock is enabled, else app sign-in is off.
  appClientId: ""
```

Under `oidcMock.clients:` after `cli:`:

```yaml
    app:
      id: opencode-rc-app
      redirectUris: ["com.opencode.rc:/auth/callback"]
```

`_helpers.tpl`, after the `opencode-rc.oidcCliClientId` define:

```
{{- define "opencode-rc.oidcAppClientId" -}}
{{- if .Values.oidc.appClientId -}}
{{- .Values.oidc.appClientId -}}
{{- else if .Values.oidcMock.enabled -}}
{{- .Values.oidcMock.clients.app.id -}}
{{- end -}}
{{- end -}}
```

`api-deployment.yaml`, after the `OIDC_CLI_CLIENT_ID` entry:

```yaml
            - name: OIDC_APP_CLIENT_ID
              value: {{ include "opencode-rc.oidcAppClientId" . | quote }}
```

`oidc-mock-configmap.yaml`, after the `cli` client block:

```yaml
    {{- with .Values.oidcMock.clients.app }}
      - id: {{ .id }}
        redirect_uris:
        {{- range .redirectUris }}
          - {{ . }}
        {{- end }}
    {{- end }}
```

`charts/opencode-rc/README.md`: add `oidc.appClientId` and `oidcMock.clients.app` to the values table, following the rows for `oidc.cliClientId` and `oidcMock.clients.cli`.

- [ ] **Step 4: Run the chart tests**

Run: `helm unittest charts/opencode-rc`
Expected: all pass.

- [ ] **Step 5: Add the e2e test**

In `e2e/e2e.test.ts` (it already imports from `./helpers`; add `createHash`, `randomBytes` from `node:crypto` and `OIDC_URL` if missing):

```ts
describe("app sign-in", () => {
  async function appCode(verifier: string): Promise<URL> {
    const cfg = await (await fetch(`${API_URL}/auth/app-config`)).json();
    expect(cfg.clientId).toBe("opencode-rc-app");
    expect(cfg.redirectUri).toBe("com.opencode.rc:/auth/callback");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const res = await fetch(`${OIDC_URL}/authorize/callback`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        sub: "user1",
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        state: "st",
        nonce: "n1",
        scope: "openid email profile",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
      redirect: "manual",
    });
    const location = new URL(res.headers.get("location")!);
    expect(location.protocol).toBe("com.opencode.rc:");
    expect(location.searchParams.get("state")).toBe("st");
    return location;
  }

  it("signs in as the app's public client", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const location = await appCode(verifier);
    const res = await postJson("/auth/app-token", {
      code: location.searchParams.get("code"),
      code_verifier: verifier,
      nonce: "n1",
    });
    expect(res.status).toBe(200);
    const { access_token } = await res.json();
    const me = await fetch(`${API_URL}/api/me`, { headers: { authorization: `Bearer ${access_token}` } });
    expect(me.status).toBe(200);
  });

  it("rejects a wrong verifier", async () => {
    const location = await appCode(randomBytes(32).toString("base64url"));
    const res = await postJson("/auth/app-token", {
      code: location.searchParams.get("code"),
      code_verifier: randomBytes(32).toString("base64url"),
      nonce: "n1",
    });
    expect(res.status).toBe(400);
  });
});
```

Run `cd e2e && npx tsc --noEmit -p .` (type check only; the e2e suite runs in Task 13).
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add charts e2e/e2e.test.ts
git commit -m "feat(chart): app OIDC client and its mock registration"
```

---

### Task 3: UI bridge client (`native.ts`)

**Files:**
- Create: `ui/src/native.ts`
- Test: `ui/src/native.test.ts`

**Interfaces:**
- Produces:
  - `type NativePlatform = "ios" | "android"`
  - `class NativeError extends Error { readonly code: string }`
  - `nativePlatform(): NativePlatform | null`
  - `isNativeApp(): boolean`
  - `nativeCall<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T>`
  - `nativeOn(event: string, handler: (data: unknown) => void): () => void`
  - Global `window.__rcNativeEmit(event: string, data: unknown)` (called by the iOS shell).
- Wire protocol (shells implement it):
  - iOS: `window.webkit.messageHandlers.rcNative.postMessage({ method, args })` returns a promise; a rejection's message is `"<code>: <message>"`.
  - Android: `window.rcNativePort.postMessage(JSON.stringify({ id, method, args }))`; replies `{"id":1,"result":...}` or `{"id":1,"error":{"code":"...","message":"..."}}`; events `{"event":"...","data":...}` via `rcNativePort.onmessage`.

- [ ] **Step 1: Write the failing test**

`ui/src/native.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest"
import { NativeError, isNativeApp, nativeCall, nativeOn, nativePlatform } from "./native"

const g = globalThis as Record<string, unknown>

afterEach(() => {
  delete g.webkit
  delete g.rcNativePort
})

describe("native bridge", () => {
  it("is not native in a browser", async () => {
    expect(nativePlatform()).toBeNull()
    expect(isNativeApp()).toBe(false)
    await expect(nativeCall("signIn")).rejects.toMatchObject({ code: "failed" })
  })

  it("calls the iOS message handler and resolves with its reply", async () => {
    const postMessage = vi.fn(async () => ({ url: "com.opencode.rc:/auth/callback?code=x" }))
    g.webkit = { messageHandlers: { rcNative: { postMessage } } }
    expect(nativePlatform()).toBe("ios")
    expect(await nativeCall("signIn", { url: "https://idp/" })).toEqual({ url: "com.opencode.rc:/auth/callback?code=x" })
    expect(postMessage).toHaveBeenCalledWith({ method: "signIn", args: { url: "https://idp/" } })
  })

  it("turns an iOS error string into a NativeError", async () => {
    g.webkit = { messageHandlers: { rcNative: { postMessage: async () => Promise.reject(new Error("cancelled: closed by user")) } } }
    const err = await nativeCall("signIn").catch((e) => e)
    expect(err).toBeInstanceOf(NativeError)
    expect(err.code).toBe("cancelled")
    expect(err.message).toBe("closed by user")
  })

  it("matches Android replies to calls by id", async () => {
    const sent: string[] = []
    const port: { postMessage: (m: string) => void; onmessage: ((e: { data: string }) => void) | null } = {
      postMessage: (m) => sent.push(m),
      onmessage: null,
    }
    g.rcNativePort = port
    expect(nativePlatform()).toBe("android")
    const a = nativeCall("signIn", { url: "https://a/" })
    const b = nativeCall("signIn", { url: "https://b/" })
    const [ma, mb] = sent.map((s) => JSON.parse(s))
    expect(ma).toMatchObject({ method: "signIn", args: { url: "https://a/" } })
    port.onmessage!({ data: JSON.stringify({ id: mb.id, error: { code: "cancelled", message: "superseded" } }) })
    port.onmessage!({ data: JSON.stringify({ id: ma.id, result: { url: "u" } }) })
    expect(await a).toEqual({ url: "u" })
    await expect(b).rejects.toMatchObject({ code: "cancelled", message: "superseded" })
  })

  it("delivers events from both shells", () => {
    const seen: unknown[] = []
    const off = nativeOn("ws.open", (d) => seen.push(d))
    ;(g.__rcNativeEmit as (e: string, d: unknown) => void)("ws.open", { id: "1" })
    const port = { postMessage: () => {}, onmessage: null as ((e: { data: string }) => void) | null }
    g.rcNativePort = port
    void nativeCall("noop").catch(() => {})
    port.onmessage!({ data: JSON.stringify({ event: "ws.open", data: { id: "2" } }) })
    off()
    ;(g.__rcNativeEmit as (e: string, d: unknown) => void)("ws.open", { id: "3" })
    expect(seen).toEqual([{ id: "1" }, { id: "2" }])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && bunx vitest run src/native.test.ts`
Expected: FAIL, module `./native` not found.

- [ ] **Step 3: Implement `ui/src/native.ts`**

```ts
// The bridge to the app shells (ui/ios/App/App/Bridge.swift, ui/android/.../Bridge.java).
// iOS: a WKScriptMessageHandlerWithReply named "rcNative"; postMessage returns a promise and
// errors arrive as "<code>: <message>". Native events call window.__rcNativeEmit.
// Android: a WebMessageListener object "rcNativePort", limited to the app origin; JSON messages
// with ids, and events as { event, data }.
export type NativePlatform = "ios" | "android"

export class NativeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface IOSHandler {
  postMessage(message: unknown): Promise<unknown>
}

interface AndroidPort {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

type Handler = (data: unknown) => void

const g = globalThis as { webkit?: { messageHandlers?: { rcNative?: IOSHandler } }; rcNativePort?: AndroidPort }

function iosHandler(): IOSHandler | undefined {
  return g.webkit?.messageHandlers?.rcNative
}

function androidPort(): AndroidPort | undefined {
  return g.rcNativePort
}

export function nativePlatform(): NativePlatform | null {
  if (iosHandler()) return "ios"
  if (androidPort()) return "android"
  return null
}

export function isNativeApp(): boolean {
  return nativePlatform() !== null
}

const handlers = new Map<string, Set<Handler>>()

function emit(event: string, data: unknown) {
  for (const handler of handlers.get(event) ?? []) handler(data)
}

;(globalThis as { __rcNativeEmit?: typeof emit }).__rcNativeEmit = emit

export function nativeOn(event: string, handler: Handler): () => void {
  let set = handlers.get(event)
  if (!set) handlers.set(event, (set = new Set()))
  set.add(handler)
  return () => set.delete(handler)
}

function toNativeError(err: unknown): NativeError {
  const text = err instanceof Error ? err.message : String(err)
  const match = text.match(/^([a-z_]+): ?([\s\S]*)$/)
  return match ? new NativeError(match[1], match[2]) : new NativeError("failed", text)
}

let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
let wiredPort: AndroidPort | null = null

function wire(port: AndroidPort) {
  if (wiredPort === port) return
  wiredPort = port
  port.onmessage = (e) => {
    let msg: { id?: number; result?: unknown; error?: { code?: string; message?: string }; event?: string; data?: unknown }
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }
    if (typeof msg.event === "string") return emit(msg.event, msg.data)
    const call = msg.id === undefined ? undefined : pending.get(msg.id)
    if (!call) return
    pending.delete(msg.id!)
    if (msg.error) call.reject(new NativeError(msg.error.code ?? "failed", msg.error.message ?? ""))
    else call.resolve(msg.result)
  }
}

export async function nativeCall<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const ios = iosHandler()
  if (ios) {
    try {
      return (await ios.postMessage({ method, args })) as T
    } catch (err) {
      throw toNativeError(err)
    }
  }
  const port = androidPort()
  if (!port) throw new NativeError("failed", "not running in the app")
  wire(port)
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    port.postMessage(JSON.stringify({ id, method, args }))
  })
}
```

- [ ] **Step 4: Run the test**

Run: `cd ui && bunx vitest run src/native.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/native.ts ui/src/native.test.ts
git commit -m "feat(ui): bridge client for the app shells"
```

---

### Task 4: UI app sign-in

**Files:**
- Modify: `ui/src/auth.ts`, `ui/src/protocol-screen.tsx`
- Delete: `ui/src/system-auth.ts`
- Test: `ui/src/auth-native.test.ts` (rewrite), plus any test that mocks `@capacitor/core` (`grep -rln "@capacitor/core" ui/src`)

**Interfaces:**
- Consumes: `isNativeApp`, `nativeCall`, `NativeError` (Task 3); `/auth/app-config`, `/auth/app-token` (Task 1).
- Produces: `APP_CALLBACK_SCHEME = "com.opencode.rc"` exported from `auth.ts` (`APP_CALLBACK` is removed). Bridge method `signIn({ url, callbackScheme })` → `{ url }` (the callback URL), errors `cancelled`/`failed`.

- [ ] **Step 1: Write the failing test**

Replace `ui/src/auth-native.test.ts` with:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("./native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native")>()),
  isNativeApp: () => true,
  nativeCall: call,
}))

import { NativeError } from "./native"
import { REFRESH_KEY, login, resetAuthState } from "./auth"
import { resetConfig } from "./server"
import { resetProtocolState } from "./protocol"

const appConfig = {
  authorizationEndpoint: "https://idp.example.com/authorize",
  clientId: "opencode-rc-app",
  redirectUri: "com.opencode.rc:/auth/callback",
  prompt: "select_account",
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

// Answers like the IdP: the callback carries the state from the authorization URL.
function idpReturns(params: Record<string, string>, opts: { keepState?: boolean } = { keepState: true }) {
  call.mockImplementation(async (_method: string, args: { url: string }) => {
    const state = new URL(args.url).searchParams.get("state")!
    const q = new URLSearchParams({ ...(opts.keepState ? { state } : { state: "other" }), ...params })
    return { url: `com.opencode.rc:/auth/callback?${q}` }
  })
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetConfig()
  resetAuthState()
  resetProtocolState()
  call.mockReset()
  localStorage.setItem("opencode-rc-endpoint", "https://rc.example.com")
})

afterEach(() => vi.restoreAllMocks())

describe("app sign-in", () => {
  it("signs in at the IdP as the public client and exchanges the code with the verifier", async () => {
    idpReturns({ code: "abc+1" })
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(appConfig))
      .mockResolvedValueOnce(json({ access_token: "a", refresh_token: "r", expires_in: 900 }))

    expect(await login()).toBe("ok")

    expect(fetchSpy.mock.calls[0][0]).toBe("https://rc.example.com/auth/app-config")
    const [method, args] = call.mock.calls[0]
    expect(method).toBe("signIn")
    expect(args.callbackScheme).toBe("com.opencode.rc")
    const u = new URL(args.url)
    expect(u.origin + u.pathname).toBe("https://idp.example.com/authorize")
    expect(u.searchParams.get("response_type")).toBe("code")
    expect(u.searchParams.get("client_id")).toBe("opencode-rc-app")
    expect(u.searchParams.get("redirect_uri")).toBe("com.opencode.rc:/auth/callback")
    expect(u.searchParams.get("scope")).toBe("openid email profile")
    expect(u.searchParams.get("code_challenge_method")).toBe("S256")
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(u.searchParams.get("prompt")).toBe("select_account")
    const nonce = u.searchParams.get("nonce")
    expect(nonce).toBeTruthy()

    const [tokenUrl, init] = fetchSpy.mock.calls[1] as [string, RequestInit]
    expect(tokenUrl).toBe("https://rc.example.com/auth/app-token")
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ code: "abc+1", code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), nonce })
    expect(localStorage.getItem(REFRESH_KEY)).toBe("r")
    expect(sessionStorage.length).toBe(0)
  })

  it("reports cancelled when the user closes the browser view", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(appConfig))
    call.mockRejectedValue(new NativeError("cancelled", "closed"))
    expect(await login()).toBe("cancelled")
  })

  it("reports failed on a bridge error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(appConfig))
    call.mockRejectedValue(new NativeError("failed", "no browser"))
    expect(await login()).toBe("failed")
  })

  it("reports failed when the server has no app sign-in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "not_found" }, 404))
    expect(await login()).toBe("failed")
    expect(call).not.toHaveBeenCalled()
  })

  it("reports failed on a state mismatch without exchanging the code", async () => {
    idpReturns({ code: "abc" }, { keepState: false })
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(appConfig))
    expect(await login()).toBe("failed")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("reports failed when the IdP returns an error", async () => {
    idpReturns({ error: "access_denied" })
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(appConfig))
    expect(await login()).toBe("failed")
  })

  it("reports failed when the code exchange is rejected", async () => {
    idpReturns({ code: "abc" })
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(appConfig))
      .mockResolvedValueOnce(json({ error: "invalid_grant" }, 400))
    expect(await login()).toBe("failed")
  })

  it("reports failed without a configured server", async () => {
    localStorage.removeItem("opencode-rc-endpoint")
    expect(await login()).toBe("failed")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && bunx vitest run src/auth-native.test.ts`
Expected: FAIL (the old flow calls `/auth/start`).

- [ ] **Step 3: Implement**

`ui/src/auth.ts`:
1. Replace `import { Capacitor } from "@capacitor/core"` with `import { NativeError, isNativeApp, nativeCall } from "./native"` and delete `import { SystemAuth } from "./system-auth"`.
2. Replace the `APP_CALLBACK_SCHEME`/`APP_CALLBACK` block with:

```ts
// The apps' sign-in callback scheme; the redirect URI comes from /auth/app-config.
export const APP_CALLBACK_SCHEME = "com.opencode.rc"
```

3. Replace the `nativeLogin` function and its comment with:

```ts
interface AppConfig {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  prompt?: string
}

function randomString(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

// The apps sign in as a public OIDC client in the system browser view (iOS
// SFSafariViewController, Android Custom Tab), which loads only the IdP; the API exchanges the
// code. The verifier, state and nonce never leave the app.
async function nativeLogin(verifier: string, challenge: string): Promise<LoginResult> {
  if (!getBaseUrl()) return "failed"
  let cfg: AppConfig
  try {
    const res = await fetch(apiUrl("/auth/app-config"))
    if (!res.ok) return "failed"
    cfg = (await res.json()) as AppConfig
  } catch {
    return "failed"
  }
  const state = randomString(16)
  const nonce = randomString(16)
  let authorize: URL
  try {
    authorize = new URL(cfg.authorizationEndpoint)
  } catch {
    return "failed"
  }
  const params: Record<string, string> = {
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }
  if (cfg.prompt) params.prompt = cfg.prompt
  for (const [k, v] of Object.entries(params)) authorize.searchParams.set(k, v)

  let callback: URL
  try {
    const result = await nativeCall<{ url: string }>("signIn", {
      url: authorize.href,
      callbackScheme: APP_CALLBACK_SCHEME,
    })
    callback = new URL(result.url)
  } catch (err) {
    return err instanceof NativeError && err.code === "cancelled" ? "cancelled" : "failed"
  }
  if (callback.searchParams.get("state") !== state) return "failed"
  const code = callback.searchParams.get("code")
  if (!code) return "failed"
  try {
    const res = await postJson("/auth/app-token", { code, code_verifier: verifier, nonce })
    if (!res.ok) return "failed"
    save((await res.json()) as TokenResponse)
    return "ok"
  } catch {
    return "failed"
  }
}
```

4. In `login()`: `if (isNativeApp()) return nativeLogin(verifier, challenge)`.
5. Delete `codeFromFragment` if nothing else uses it (`grep -n codeFromFragment ui/src/*.ts`). Check that `save` and `TokenResponse` are the names used by `exchangeCode`; if `save` has another name, use that.

`ui/src/protocol-screen.tsx`: replace the import with `import { isNativeApp } from "./native"` and `const native = isNativeApp()`.

Delete `ui/src/system-auth.ts`. In every other test that mocks `@capacitor/core` (`grep -rln "@capacitor/core\|system-auth" ui/src`), mock `./native` instead: `vi.mock("./native", async (o) => ({ ...(await o<typeof import("./native")>()), isNativeApp: () => true }))`.

- [ ] **Step 4: Run the UI tests and type check**

Run: `cd ui && bun run test && bun run typecheck`
Expected: all pass; `grep -rn "@capacitor" ui/src` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add -A ui/src
git commit -m "feat(ui): app sign-in at the IdP as a public client"
```

---

### Task 5: UI iOS transport (`native-transport.ts`)

**Files:**
- Create: `ui/src/native-transport.ts`
- Modify: `ui/src/entry.tsx`
- Test: `ui/src/native-transport.test.ts`

**Interfaces:**
- Consumes: `nativeCall`, `nativeOn`, `nativePlatform` (Task 3); `getBaseUrl` (`ui/src/server.ts`).
- Produces:
  - `SERVER_PREFIX = "/__server"`
  - `transportUrl(input: string, server: string, pageBase: string): string | null` — the local path for a request to `server`, else `null`.
  - `installNativeTransport(opts: { getServer: () => string }): void` — patches `fetch`, `XMLHttpRequest.prototype.open`, `EventSource`, `WebSocket`.
- Bridge methods used (iOS shell implements them in Tasks 7–9): `setServer({ origin })`; `wsOpen({ id, url, protocols })`; `wsSend({ id, text } | { id, base64 })`; `wsClose({ id, code, reason })`. Events: `ws.open { id, protocol }`, `ws.message { id, text } | { id, base64 }`, `ws.close { id, code, reason, wasClean }`, `ws.error { id, message }`.

- [ ] **Step 1: Write the failing test**

`ui/src/native-transport.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { SERVER_PREFIX, installNativeTransport, transportUrl } from "./native-transport"

const g = globalThis as Record<string, unknown>
const SERVER = "https://rc.example.com"
const PAGE = "opencode-rc://localhost"

describe("transportUrl", () => {
  it("maps requests to the server onto the local prefix", () => {
    expect(transportUrl("https://rc.example.com/api/me?x=1", SERVER, PAGE)).toBe("/__server/api/me?x=1")
    expect(transportUrl("https://rc.example.com", SERVER, PAGE)).toBe("/__server/")
  })
  it("leaves other targets alone", () => {
    expect(transportUrl("/assets/a.js", SERVER, PAGE)).toBeNull()
    expect(transportUrl("https://other.example.com/x", SERVER, PAGE)).toBeNull()
    expect(transportUrl("http://rc.example.com/x", SERVER, PAGE)).toBeNull()
    expect(transportUrl("https://rc.example.com/x", "", PAGE)).toBeNull()
  })
})

describe("installNativeTransport", () => {
  const originals = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, open: XMLHttpRequest.prototype.open }
  let postMessage: ReturnType<typeof vi.fn>
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    postMessage = vi.fn(async () => null)
    g.webkit = { messageHandlers: { rcNative: { postMessage } } }
    fetchSpy = vi.fn(async () => new Response("ok"))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    installNativeTransport({ getServer: () => SERVER })
  })

  afterEach(() => {
    globalThis.fetch = originals.fetch
    globalThis.WebSocket = originals.WebSocket
    XMLHttpRequest.prototype.open = originals.open
    delete g.webkit
    delete g.EventSource
  })

  it("sends server requests to the local prefix with method, headers and body", async () => {
    await fetch("https://rc.example.com/proxy/s/message", {
      method: "POST",
      headers: { authorization: "Bearer t" },
      body: "hello",
    })
    expect(postMessage).toHaveBeenCalledWith({ method: "setServer", args: { origin: SERVER } })
    const req = fetchSpy.mock.calls[0][0] as Request
    expect(new URL(req.url).pathname).toBe(`${SERVER_PREFIX}/proxy/s/message`)
    expect(req.method).toBe("POST")
    expect(req.headers.get("authorization")).toBe("Bearer t")
    expect(await req.text()).toBe("hello")
  })

  it("sets the server once until it changes", async () => {
    await fetch("https://rc.example.com/a")
    await fetch("https://rc.example.com/b")
    expect(postMessage.mock.calls.filter(([m]) => m.method === "setServer")).toHaveLength(1)
  })

  it("passes bundle requests through unchanged", async () => {
    await fetch("/assets/app.js")
    expect(fetchSpy).toHaveBeenCalledWith("/assets/app.js", undefined)
  })

  it("maps XMLHttpRequest URLs", () => {
    const seen: string[] = []
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, _m: string, url: string | URL) {
      seen.push(String(url))
    } as typeof XMLHttpRequest.prototype.open
    installNativeTransport({ getServer: () => SERVER })
    new XMLHttpRequest().open("POST", "https://rc.example.com/api/experimental/fs/write")
    new XMLHttpRequest().open("GET", "/assets/a.json")
    expect(seen).toEqual(["/__server/api/experimental/fs/write", "/assets/a.json"])
  })

  it("maps EventSource URLs", () => {
    const created: string[] = []
    class FakeEventSource {
      constructor(url: string) {
        created.push(url)
      }
    }
    g.EventSource = FakeEventSource
    installNativeTransport({ getServer: () => SERVER })
    new (g.EventSource as new (url: string) => unknown)("https://rc.example.com/proxy/s/event")
    expect(created).toEqual(["/__server/proxy/s/event"])
  })

  it("opens WebSockets through the bridge and relays events", async () => {
    const ws = new WebSocket("wss://rc.example.com/proxy/s/pty/1?access_token=t")
    ws.binaryType = "arraybuffer"
    const events: string[] = []
    ws.onopen = () => events.push("open")
    ws.onmessage = (e) => events.push(typeof e.data === "string" ? `text:${e.data}` : `bin:${new Uint8Array(e.data)[0]}`)
    ws.onclose = (e) => events.push(`close:${e.code}`)
    await vi.waitFor(() => expect(postMessage.mock.calls.some(([m]) => m.method === "wsOpen")).toBe(true))
    const open = postMessage.mock.calls.find(([m]) => m.method === "wsOpen")![0].args
    expect(open.url).toBe("wss://rc.example.com/proxy/s/pty/1?access_token=t")
    const emit = g.__rcNativeEmit as (e: string, d: unknown) => void
    emit("ws.open", { id: open.id, protocol: "" })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.send("ls")
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({ method: "wsSend", args: { id: open.id, text: "ls" } }),
    )
    emit("ws.message", { id: open.id, text: "hi" })
    emit("ws.message", { id: open.id, base64: "Kg==" })
    emit("ws.close", { id: open.id, code: 1000, reason: "", wasClean: true })
    expect(events).toEqual(["open", "text:hi", "bin:42", "close:1000"])
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && bunx vitest run src/native-transport.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `ui/src/native-transport.ts`**

```ts
import { nativeCall, nativeOn } from "./native"

// iOS app: the WebView makes no network requests of its own. Requests to the server go to the
// app's scheme (opencode-rc://localhost/__server/...), which the shell forwards with URLSession
// (ui/ios/App/App/ServerProxy.swift); WebSockets go through the bridge (WebSocketBridge.swift).
// URLSession traffic is the app's own, so a per-app VPN carries it. Installed before the proxy
// patches (proxy-fetch.ts), which then build on these.
export const SERVER_PREFIX = "/__server"

function hostOf(url: URL): string {
  return `${url.protocol}//${url.host}`
}

export function transportUrl(input: string, server: string, pageBase: string): string | null {
  if (!server) return null
  let url: URL
  let target: URL
  try {
    url = new URL(input, `${pageBase}/`)
    target = new URL(server)
  } catch {
    return null
  }
  if (hostOf(url) !== hostOf(target)) return null
  return `${SERVER_PREFIX}${url.pathname}${url.search}`
}

function pageBase(): string {
  return `${location.protocol}//${location.host}`
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

async function encodeMessage(data: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<{ text: string } | { base64: string }> {
  if (typeof data === "string") return { text: data }
  if (data instanceof Blob) return { base64: bytesToBase64(new Uint8Array(await data.arrayBuffer())) }
  if (ArrayBuffer.isView(data)) return { base64: bytesToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) }
  return { base64: bytesToBase64(new Uint8Array(data as ArrayBuffer)) }
}

export function installNativeTransport(opts: { getServer: () => string }): void {
  let sentServer: string | null = null
  const syncServer = async () => {
    const server = opts.getServer()
    if (!server || server === sentServer) return
    await nativeCall("setServer", { origin: server })
    sentServer = server
  }
  const map = (input: string) => transportUrl(input, opts.getServer(), pageBase())

  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const local = map(raw)
    if (!local) return originalFetch(input, init)
    await syncServer()
    const source = input instanceof Request ? input : new Request(new URL(raw, `${pageBase()}/`).href, init)
    const hasBody = source.method !== "GET" && source.method !== "HEAD"
    // Buffered, as in proxy-fetch.ts: WebKit does not stream request bodies.
    const body = hasBody ? await source.clone().arrayBuffer() : undefined
    return originalFetch(
      new Request(`${pageBase()}${local}`, {
        method: source.method,
        headers: source.headers,
        body,
        signal: init?.signal ?? source.signal,
        redirect: source.redirect,
      }),
    )
  }

  const proto = XMLHttpRequest.prototype
  const originalOpen = proto.open
  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    const local = map(String(url))
    if (local) void syncServer()
    return (originalOpen as (...a: unknown[]) => void).call(this, method, local ?? url, ...rest)
  } as typeof proto.open

  const g = globalThis as { EventSource?: new (url: string | URL, init?: EventSourceInit) => EventSource }
  if (g.EventSource) {
    const Original = g.EventSource
    g.EventSource = class extends Original {
      constructor(url: string | URL, init?: EventSourceInit) {
        const local = map(String(url))
        if (local) void syncServer()
        super(local ?? url, init)
      }
    }
  }

  globalThis.WebSocket = makeNativeWebSocket(syncServer) as unknown as typeof WebSocket
}

let socketCount = 0

function makeNativeWebSocket(syncServer: () => Promise<void>) {
  const sockets = new Map<string, NativeWebSocket>()
  nativeOn("ws.open", (d) => {
    const { id, protocol } = d as { id: string; protocol?: string }
    sockets.get(id)?.opened(protocol ?? "")
  })
  nativeOn("ws.message", (d) => {
    const m = d as { id: string; text?: string; base64?: string }
    sockets.get(m.id)?.received(m.text, m.base64)
  })
  nativeOn("ws.error", (d) => sockets.get((d as { id: string }).id)?.errored())
  nativeOn("ws.close", (d) => {
    const c = d as { id: string; code: number; reason: string; wasClean: boolean }
    const socket = sockets.get(c.id)
    sockets.delete(c.id)
    socket?.closed(c.code, c.reason, c.wasClean)
  })

  class NativeWebSocket extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSING = 2
    readonly CLOSED = 3
    readonly url: string
    readyState = 0
    protocol = ""
    extensions = ""
    bufferedAmount = 0
    binaryType: BinaryType = "blob"
    onopen: ((ev: Event) => unknown) | null = null
    onmessage: ((ev: MessageEvent) => unknown) | null = null
    onerror: ((ev: Event) => unknown) | null = null
    onclose: ((ev: CloseEvent) => unknown) | null = null
    private readonly id = `ws-${++socketCount}`
    private queue: Promise<unknown> = Promise.resolve()

    constructor(url: string | URL, protocols?: string | string[]) {
      super()
      this.url = String(url)
      sockets.set(this.id, this)
      const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols]
      this.queue = syncServer()
        .then(() => nativeCall("wsOpen", { id: this.id, url: this.url, protocols: list }))
        .catch(() => {
          this.errored()
          sockets.delete(this.id)
          this.closed(1006, "", false)
        })
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.readyState === 0) throw new DOMException("Still in CONNECTING state.", "InvalidStateError")
      if (this.readyState !== 1) return
      this.queue = this.queue
        .then(() => encodeMessage(data))
        .then((msg) => nativeCall("wsSend", { id: this.id, ...msg }))
        .catch(() => {})
    }

    close(code = 1000, reason = "") {
      if (this.readyState >= 2) return
      this.readyState = 2
      this.queue = this.queue.then(() => nativeCall("wsClose", { id: this.id, code, reason })).catch(() => {})
    }

    private fire(type: "open" | "message" | "error" | "close", ev: Event) {
      this.dispatchEvent(ev)
      const handler = this[`on${type}`] as ((ev: Event) => unknown) | null
      handler?.call(this, ev)
    }

    opened(protocol: string) {
      this.protocol = protocol
      this.readyState = 1
      this.fire("open", new Event("open"))
    }

    received(text?: string, base64?: string) {
      let data: unknown = text
      if (base64 !== undefined) {
        const bytes = base64ToBytes(base64)
        data = this.binaryType === "arraybuffer" ? bytes.buffer : new Blob([bytes])
      }
      this.fire("message", new MessageEvent("message", { data }))
    }

    errored() {
      this.fire("error", new Event("error"))
    }

    closed(code: number, reason: string, wasClean: boolean) {
      this.readyState = 3
      this.fire("close", new CloseEvent("close", { code, reason, wasClean }))
    }
  }
  return NativeWebSocket
}
```

`ui/src/entry.tsx`, after the polyfills and imports (before any other code runs requests):

```ts
import { nativePlatform } from "./native"
import { installNativeTransport } from "./native-transport"
import { getBaseUrl } from "./server"

// iOS: server traffic goes through the shell (native-transport.ts). Before anything patches fetch.
if (nativePlatform() === "ios") installNativeTransport({ getServer: getBaseUrl })
```

(If `entry.tsx` imports `getBaseUrl` through `./api`, import it from there instead.)

- [ ] **Step 4: Run the tests**

Run: `cd ui && bunx vitest run src/native-transport.test.ts && bun run test && bun run typecheck`
Expected: all pass. If jsdom lacks `CloseEvent`, define a minimal one in the test setup file the UI tests already use (`grep -n setupFiles ui/vite*.ts ui/vitest*.ts`), not in the module.

- [ ] **Step 5: Commit**

```bash
git add ui/src/native-transport.ts ui/src/native-transport.test.ts ui/src/entry.tsx
git commit -m "feat(ui): send iOS server traffic through the app shell"
```

---

### Task 6: Mobile sync script and iOS CSP

**Files:**
- Create: `ui/build/sync-mobile.ts`
- Modify: `ui/package.json` (scripts only)
- Test: `ui/build/sync-mobile.test.ts`

**Interfaces:**
- Produces: `iosCsp(html: string): string`; `syncMobile(target: "ios" | "android", dist: string, dest: string): void`; scripts `bun run sync:ios`, `bun run sync:android`.
- Destinations: iOS `ui/ios/App/App/public`, Android `ui/android/app/src/main/assets/public`.

- [ ] **Step 1: Write the failing test**

`ui/build/sync-mobile.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { iosCsp, syncMobile } from "./sync-mobile"

const META = `<meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; connect-src &#39;self&#39; data: https://rc.example.com wss://rc.example.com; object-src &#39;none&#39;">`

describe("iosCsp", () => {
  it("allows connections only to the app itself", () => {
    expect(iosCsp(META)).toContain("connect-src &#39;self&#39; data:; object-src")
    expect(iosCsp(META)).not.toContain("rc.example.com")
  })
  it("leaves a page without a policy alone", () => {
    expect(iosCsp("<html></html>")).toBe("<html></html>")
  })
})

describe("syncMobile", () => {
  function dist() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rc-dist-"))
    fs.mkdirSync(path.join(root, "v2", "assets"), { recursive: true })
    fs.writeFileSync(path.join(root, "index.html"), META)
    fs.writeFileSync(path.join(root, "v2", "index.html"), META)
    fs.writeFileSync(path.join(root, "v2", "assets", "a.js"), "x")
    return root
  }

  it("replaces the destination and rewrites every index.html for iOS", () => {
    const src = dist()
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rc-dest-")), "public")
    fs.mkdirSync(dest)
    fs.writeFileSync(path.join(dest, "stale.js"), "old")
    syncMobile("ios", src, dest)
    expect(fs.existsSync(path.join(dest, "stale.js"))).toBe(false)
    expect(fs.readFileSync(path.join(dest, "v2", "assets", "a.js"), "utf8")).toBe("x")
    for (const f of ["index.html", "v2/index.html"])
      expect(fs.readFileSync(path.join(dest, f), "utf8")).not.toContain("rc.example.com")
  })

  it("copies Android unchanged", () => {
    const src = dist()
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rc-dest-")), "public")
    syncMobile("android", src, dest)
    expect(fs.readFileSync(path.join(dest, "index.html"), "utf8")).toBe(META)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && bunx vitest run build/sync-mobile.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `ui/build/sync-mobile.ts`**

```ts
// Copies the built UI (dist/) into the app projects. The iOS copy's CSP allows connections only
// to the app itself: the iOS shell forwards server requests (src/native-transport.ts).
//   bun build/sync-mobile.ts ios|android
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEST = {
  ios: "ios/App/App/public",
  android: "android/app/src/main/assets/public",
} as const

export function iosCsp(html: string): string {
  return html.replace(/connect-src [^;"]*/, (match) =>
    match.includes("&#39;") ? "connect-src &#39;self&#39; data:" : "connect-src 'self' data:",
  )
}

function indexFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => path.basename(f) === "index.html")
    .map((f) => path.join(dir, f))
}

export function syncMobile(target: keyof typeof DEST, dist: string, dest: string): void {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error(`${dist}/index.html is missing: build the UI first`)
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(dist, dest, { recursive: true })
  if (target === "ios") for (const f of indexFiles(dest)) fs.writeFileSync(f, iosCsp(fs.readFileSync(f, "utf8")))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const target = process.argv[2]
  if (target !== "ios" && target !== "android") {
    console.error("usage: bun build/sync-mobile.ts ios|android")
    process.exit(2)
  }
  const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  syncMobile(target, path.join(ui, "dist"), path.join(ui, DEST[target]))
  console.log(`synced dist/ to ${DEST[target]}`)
}
```

`ui/package.json` scripts, add:

```json
    "sync:ios": "bun build/sync-mobile.ts ios",
    "sync:android": "bun build/sync-mobile.ts android",
```

- [ ] **Step 4: Run the tests**

Run: `cd ui && bunx vitest run build/sync-mobile.test.ts && bun run build && bun run sync:ios && grep -o "connect-src[^;]*" ios/App/App/public/index.html`
Expected: tests PASS; the grep prints `connect-src &#39;self&#39; data:`.

- [ ] **Step 5: Commit**

```bash
git add ui/build/sync-mobile.ts ui/build/sync-mobile.test.ts ui/package.json
git commit -m "build(ui): sync the built UI into the app projects"
```

---

### Task 7: iOS shell (bundle, navigation, bridge) without Capacitor

**Files:**
- Create: `ui/ios/App/App/WebViewController.swift`, `AppSchemeHandler.swift`, `BundleFiles.swift`, `NavigationPolicy.swift`, `Bridge.swift`
- Modify: `ui/ios/App/App/AppDelegate.swift`, `ui/ios/App/App/SceneDelegate.swift`, `ui/ios/App/App.xcodeproj/project.pbxproj`, `ui/ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`, `ui/ios/.gitignore`
- Delete: `ui/ios/App/App/SystemAuthPlugin.swift`, `ui/ios/App/App/capacitor.config.json`, `ui/ios/App/App/config.xml`, `ui/ios/App/CapApp-SPM/`, `ui/ios/capacitor-cordova-ios-plugins/` (if tracked), `ui/ios/debug.xcconfig`
- Test: `ui/ios/App/AppTests/BundleFilesTests.swift`, `NavigationPolicyTests.swift`, `BridgeTests.swift`

**Interfaces:**
- Produces (Swift):
  - `enum BundleFiles { static func resolve(path: String, root: URL, fileExists: (URL) -> Bool) -> URL?; static func mimeType(for url: URL) -> String }`
  - `final class AppSchemeHandler: NSObject, WKURLSchemeHandler` with `static let scheme = "opencode-rc"`, `static let origin = "opencode-rc://localhost"`, `init(root: URL, proxy: ServerProxy?)` (`ServerProxy` arrives in Task 8; in this task the init takes only `root`).
  - `enum NavigationDecision { case allow, openExternally, cancel }`; `enum NavigationPolicy { static func decide(url: URL?, isMainFrame: Bool) -> NavigationDecision }`
  - `struct BridgeError: Error { let code: String; let message: String }`; `final class Bridge: NSObject, WKScriptMessageHandlerWithReply` with `func register(_ name: String, _ method: @escaping Bridge.Method)`, `func emit(_ event: String, _ data: [String: Any])`, `static func accepts(isMainFrame: Bool, scheme: String, host: String) -> Bool`. `typealias Method = (_ args: [String: Any], _ reply: @escaping (Result<Any?, BridgeError>) -> Void) -> Void`.
  - `final class WebViewController: UIViewController` exposing `let bridge: Bridge` and `var webView: WKWebView!`.

- [ ] **Step 1: Write the failing tests**

`ui/ios/App/AppTests/BundleFilesTests.swift`:

```swift
import XCTest
@testable import App

final class BundleFilesTests: XCTestCase {
    let root = URL(fileURLWithPath: "/bundle/public")
    let files: Set<String> = ["/bundle/public/index.html", "/bundle/public/assets/a.js",
                              "/bundle/public/v2/index.html", "/bundle/public/v2/assets/b.css"]
    func resolve(_ path: String) -> String? {
        BundleFiles.resolve(path: path, root: root, fileExists: { self.files.contains($0.path) })?.path
    }

    func testServesFiles() {
        XCTAssertEqual(resolve("/assets/a.js"), "/bundle/public/assets/a.js")
        XCTAssertEqual(resolve("/"), "/bundle/public/index.html")
        XCTAssertEqual(resolve("/v2/"), "/bundle/public/v2/index.html")
    }

    func testFallsBackToTheBuildsIndexForRoutes() {
        XCTAssertEqual(resolve("/s/abc"), "/bundle/public/index.html")
        XCTAssertEqual(resolve("/v2/s/abc"), "/bundle/public/v2/index.html")
    }

    func testMissingFilesWithAnExtensionAre404() {
        XCTAssertNil(resolve("/assets/missing.js"))
    }

    func testRejectsPathsOutsideTheBundle() {
        XCTAssertNil(resolve("/../secret.txt"))
        XCTAssertNil(resolve("/assets/../../secret.txt"))
        XCTAssertNil(resolve("/%2e%2e/secret.txt"))
    }

    func testMimeTypes() {
        XCTAssertEqual(BundleFiles.mimeType(for: URL(fileURLWithPath: "/a.js")), "text/javascript")
        XCTAssertEqual(BundleFiles.mimeType(for: URL(fileURLWithPath: "/a.wasm")), "application/wasm")
        XCTAssertEqual(BundleFiles.mimeType(for: URL(fileURLWithPath: "/a.html")), "text/html")
        XCTAssertEqual(BundleFiles.mimeType(for: URL(fileURLWithPath: "/a.bin")), "application/octet-stream")
    }
}
```

`ui/ios/App/AppTests/NavigationPolicyTests.swift`:

```swift
import XCTest
@testable import App

final class NavigationPolicyTests: XCTestCase {
    func decide(_ s: String, main: Bool = true) -> NavigationDecision {
        NavigationPolicy.decide(url: URL(string: s), isMainFrame: main)
    }

    func testAllowsTheApp() {
        XCTAssertEqual(decide("opencode-rc://localhost/s/x"), .allow)
        XCTAssertEqual(decide("opencode-rc://localhost/", main: false), .allow)
    }

    func testOpensEverythingElseOutside() {
        XCTAssertEqual(decide("https://example.com/"), .openExternally)
        XCTAssertEqual(decide("http://example.com/"), .openExternally)
        XCTAssertEqual(decide("mailto:a@example.com"), .openExternally)
        XCTAssertEqual(decide("opencode-rc://other/"), .openExternally)
    }

    func testCancelsLocalOnlySchemesAtTheTop() {
        XCTAssertEqual(decide("about:blank"), .cancel)
        XCTAssertEqual(decide("blob:opencode-rc://localhost/1"), .cancel)
        XCTAssertEqual(decide("data:text/html,x"), .cancel)
        XCTAssertEqual(NavigationPolicy.decide(url: nil, isMainFrame: true), .cancel)
    }

    func testSubframesStayInTheApp() {
        XCTAssertEqual(decide("https://example.com/", main: false), .cancel)
        XCTAssertEqual(decide("about:blank", main: false), .allow)
        XCTAssertEqual(decide("about:srcdoc", main: false), .allow)
    }
}
```

`ui/ios/App/AppTests/BridgeTests.swift`:

```swift
import XCTest
@testable import App

final class BridgeTests: XCTestCase {
    func testAcceptsOnlyTheAppsMainFrame() {
        XCTAssertTrue(Bridge.accepts(isMainFrame: true, scheme: "opencode-rc", host: "localhost"))
        XCTAssertFalse(Bridge.accepts(isMainFrame: false, scheme: "opencode-rc", host: "localhost"))
        XCTAssertFalse(Bridge.accepts(isMainFrame: true, scheme: "https", host: "localhost"))
        XCTAssertFalse(Bridge.accepts(isMainFrame: true, scheme: "opencode-rc", host: "evil"))
    }

    func testDispatchesToTheRegisteredMethod() {
        let bridge = Bridge()
        bridge.register("echo") { args, reply in reply(.success(args["v"])) }
        let done = expectation(description: "reply")
        bridge.dispatch(body: ["method": "echo", "args": ["v": 7]]) { result, error in
            XCTAssertEqual(result as? Int, 7)
            XCTAssertNil(error)
            done.fulfill()
        }
        wait(for: [done], timeout: 1)
    }

    func testUnknownMethodsFail() {
        let bridge = Bridge()
        let done = expectation(description: "reply")
        bridge.dispatch(body: ["method": "nope"]) { _, error in
            XCTAssertEqual(error, "failed: unknown method nope")
            done.fulfill()
        }
        wait(for: [done], timeout: 1)
    }
}
```

- [ ] **Step 2: Implement the Swift files**

`ui/ios/App/App/BundleFiles.swift`:

```swift
import Foundation

/// Maps request paths to files in the bundled web UI (App/public).
enum BundleFiles {
    /// The file for a request path, or nil (404). A path with no extension that matches no file is
    /// an SPA route: the index.html of its build (/v2/... for opencode 2.x, else the root).
    static func resolve(path: String, root: URL,
                        fileExists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> URL? {
        let decoded = path.removingPercentEncoding ?? path
        let base = root.standardizedFileURL
        var file = base.appendingPathComponent(decoded).standardizedFileURL
        guard file.path == base.path || file.path.hasPrefix(base.path + "/") else { return nil }
        if decoded.hasSuffix("/") || file.path == base.path { file = file.appendingPathComponent("index.html") }
        if fileExists(file) { return file }
        guard file.pathExtension.isEmpty else { return nil }
        let v2 = base.appendingPathComponent("v2/index.html")
        if decoded.hasPrefix("/v2/"), fileExists(v2) { return v2 }
        return base.appendingPathComponent("index.html")
    }

    private static let types: [String: String] = [
        "html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css",
        "json": "application/json", "map": "application/json", "svg": "image/svg+xml",
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "ico": "image/x-icon",
        "webp": "image/webp", "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf",
        "wasm": "application/wasm", "txt": "text/plain",
    ]

    static func mimeType(for url: URL) -> String {
        types[url.pathExtension.lowercased()] ?? "application/octet-stream"
    }
}
```

`ui/ios/App/App/AppSchemeHandler.swift`:

```swift
import WebKit

/// Serves opencode-rc://localhost: the bundled web UI from App/public. (Task 8 adds /__server.)
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "opencode-rc"
    static let origin = "opencode-rc://localhost"
    let root: URL

    init(root: URL) {
        self.root = root
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        guard let file = BundleFiles.resolve(path: url.path.isEmpty ? "/" : url.path, root: root),
              let data = try? Data(contentsOf: file) else {
            respond(task, url: url, status: 404, type: "text/plain", body: Data())
            return
        }
        respond(task, url: url, status: 200, type: BundleFiles.mimeType(for: file), body: data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, type: String, body: Data) {
        let headers = ["Content-Type": type, "Content-Length": String(body.count), "Cache-Control": "no-cache"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(body)
        task.didFinish()
    }
}
```

`ui/ios/App/App/NavigationPolicy.swift`:

```swift
import Foundation

enum NavigationDecision: Equatable {
    case allow, openExternally, cancel
}

/// What the main WebView may load: only the app. Other top-level loads open in Safari or the app
/// that owns the scheme; subframes may hold only the app or empty documents.
enum NavigationPolicy {
    static func decide(url: URL?, isMainFrame: Bool) -> NavigationDecision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
        if scheme == AppSchemeHandler.scheme, url.host == "localhost" { return .allow }
        if !isMainFrame { return scheme == "about" ? .allow : .cancel }
        if ["about", "blob", "data", "javascript", "file"].contains(scheme) { return .cancel }
        return .openExternally
    }
}
```

`ui/ios/App/App/Bridge.swift`:

```swift
import WebKit

struct BridgeError: Error {
    let code: String
    let message: String
    static func failed(_ message: String) -> BridgeError { BridgeError(code: "failed", message: message) }
    static func cancelled(_ message: String) -> BridgeError { BridgeError(code: "cancelled", message: message) }
}

/// The JS ↔ native bridge (ui/src/native.ts). JS calls window.webkit.messageHandlers.rcNative
/// .postMessage({method, args}) and gets a promise; errors reach JS as "<code>: <message>".
/// Native events go to window.__rcNativeEmit(event, data). Only the app's main frame may call.
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "rcNative"
    typealias Method = (_ args: [String: Any], _ reply: @escaping (Result<Any?, BridgeError>) -> Void) -> Void
    private var methods: [String: Method] = [:]
    weak var webView: WKWebView?

    func register(_ name: String, _ method: @escaping Method) {
        methods[name] = method
    }

    static func accepts(isMainFrame: Bool, scheme: String, host: String) -> Bool {
        isMainFrame && scheme == AppSchemeHandler.scheme && host == "localhost"
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard Bridge.accepts(isMainFrame: message.frameInfo.isMainFrame, scheme: origin.protocol, host: origin.host) else {
            NSLog("bridge: dropped a message from %@://%@", origin.protocol, origin.host)
            replyHandler(nil, "failed: not allowed")
            return
        }
        dispatch(body: message.body, replyHandler: replyHandler)
    }

    func dispatch(body: Any, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = body as? [String: Any], let name = body["method"] as? String else {
            replyHandler(nil, "failed: bad message")
            return
        }
        guard let method = methods[name] else {
            replyHandler(nil, "failed: unknown method \(name)")
            return
        }
        method(body["args"] as? [String: Any] ?? [:]) { result in
            switch result {
            case .success(let value): replyHandler(value, nil)
            case .failure(let error): replyHandler(nil, "\(error.code): \(error.message)")
            }
        }
    }

    func emit(_ event: String, _ data: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: ["event": event, "data": data]),
              let text = String(data: json, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("(m => window.__rcNativeEmit && window.__rcNativeEmit(m.event, m.data))(\(text))")
    }
}
```

`ui/ios/App/App/WebViewController.swift`:

```swift
import UIKit
import WebKit

/// The app: one WKWebView showing the bundled web UI from opencode-rc://localhost. The WebView sits
/// in the safe area; external links open outside the app (NavigationPolicy).
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    let bridge = Bridge()
    var webView: WKWebView!
    private lazy var schemeHandler = AppSchemeHandler(root: Bundle.main.bundleURL.appendingPathComponent("public"))

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: AppSchemeHandler.scheme)
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: Bridge.name)
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsLinkPreview = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        bridge.webView = webView

        let container = UIView()
        container.backgroundColor = .systemBackground
        container.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        view = container
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: URL(string: AppSchemeHandler.origin + "/")!))
    }

    private func handle(_ url: URL?, isMainFrame: Bool) -> WKNavigationActionPolicy {
        switch NavigationPolicy.decide(url: url, isMainFrame: isMainFrame) {
        case .allow: return .allow
        case .cancel: return .cancel
        case .openExternally:
            if let url { UIApplication.shared.open(url) }
            return .cancel
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(handle(action.request.url, isMainFrame: action.targetFrame?.isMainFrame ?? true))
    }

    // target=_blank and window.open: never a second WebView.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if NavigationPolicy.decide(url: action.request.url, isMainFrame: true) == .openExternally,
           let url = action.request.url {
            UIApplication.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }
}
```

`ui/ios/App/App/AppDelegate.swift`: remove `import Capacitor` and the template comments; keep `@UIApplicationMain`, `window`, `didFinishLaunching` returning `true`, and `configurationForConnecting` returning the `SceneDelegate` configuration.

`ui/ios/App/App/SceneDelegate.swift`: remove `import Capacitor` and `SafeAreaViewController`; set `window?.rootViewController = WebViewController()`.

Delete `SystemAuthPlugin.swift`, `capacitor.config.json`, `config.xml`, `ui/ios/App/CapApp-SPM/`, `ui/ios/debug.xcconfig` (`git rm -r`). In `ui/ios/.gitignore`, change the comment above `App/App/public/` to `# The built web UI (bun run sync:ios)` and delete the `App/Pods/` and `capacitor-cordova-ios-plugins/` lines.

- [ ] **Step 3: Update the Xcode project on the Mac**

Copy the worktree's `ui/ios` to the Mac. In `ui/ios/App`, run this script once with the system Ruby (the `xcodeproj` gem is installed):

```ruby
require 'xcodeproj'
proj = Xcodeproj::Project.open('App.xcodeproj')
app = proj.targets.find { |t| t.name == 'App' }
group = proj.main_group['App']

%w[SystemAuthPlugin.swift capacitor.config.json config.xml].each do |name|
  ref = group.files.find { |f| f.path == name } or next
  ref.build_files.each(&:remove_from_project)
  ref.remove_from_project
end
app.frameworks_build_phase.files.select { |f| f.product_ref }.each(&:remove_from_project)
app.package_product_dependencies.dup.each(&:remove_from_project)
proj.root_object.package_references.dup.each(&:remove_from_project)
xc = proj.files.find { |f| f.path == '../debug.xcconfig' }
if xc
  proj.build_configurations.each { |c| c.base_configuration_reference = nil if c.base_configuration_reference == xc }
  app.build_configurations.each { |c| c.base_configuration_reference = nil if c.base_configuration_reference == xc }
  xc.remove_from_project
end

%w[WebViewController.swift AppSchemeHandler.swift BundleFiles.swift NavigationPolicy.swift Bridge.swift].each do |name|
  app.source_build_phase.add_file_reference(group.new_reference(name))
end

tests = proj.new_target(:unit_test_bundle, 'AppTests', :ios, '15.0')
tests.add_dependency(app)
tests.build_configurations.each do |c|
  c.build_settings['TEST_HOST'] = '$(BUILT_PRODUCTS_DIR)/App.app/App'
  c.build_settings['BUNDLE_LOADER'] = '$(TEST_HOST)'
  c.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.opencode.rc.tests'
  c.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'
  c.build_settings['SWIFT_VERSION'] = '5.0'
  c.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
end
tgroup = proj.main_group.new_group('AppTests', 'AppTests')
%w[BundleFilesTests.swift NavigationPolicyTests.swift BridgeTests.swift].each do |name|
  tests.source_build_phase.add_file_reference(tgroup.new_reference(name))
end

scheme_path = 'App.xcodeproj/xcshareddata/xcschemes/App.xcscheme'
scheme = Xcodeproj::XCScheme.new(scheme_path)
scheme.test_action.add_testable(Xcodeproj::XCScheme::TestAction::TestableReference.new(tests))
scheme.save_as('App.xcodeproj', 'App', true)
proj.save
```

Check: `grep -c "CapApp-SPM\|Capacitor\|debug.xcconfig\|SystemAuthPlugin" App.xcodeproj/project.pbxproj` prints `0`. Copy `App.xcodeproj` back into the worktree.

For later tasks that add Swift files, add them the same way (one short Ruby script per task: `group.new_reference(name)` + `add_file_reference` on the right target).

- [ ] **Step 4: Build and run the tests on the Mac**

Run (on the Mac, in the copied `ui/` after `bun run build && bun run sync:ios` on Linux and copying `ios/App/App/public` across):

```bash
cd ui/ios/App
xcodebuild test -project App.xcodeproj -scheme App -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' CODE_SIGNING_ALLOWED=NO
```

Expected: `AppTests` (12 tests) and `AppUITests.testLaunchShowsSignInAndServerSettings` pass.

- [ ] **Step 5: Commit**

```bash
git add -A ui/ios
git commit -m "feat(ios): plain WKWebView shell without Capacitor"
```

---

### Task 8: iOS server proxy (HTTP and SSE through URLSession)

**Files:**
- Create: `ui/ios/App/App/ServerProxy.swift`
- Modify: `ui/ios/App/App/AppSchemeHandler.swift`, `ui/ios/App/App/WebViewController.swift`, `project.pbxproj`
- Test: `ui/ios/App/AppTests/ServerProxyTests.swift`, `ui/ios/App/AppTests/SchemeHandlerWebViewTests.swift`

**Interfaces:**
- Consumes: `AppSchemeHandler`, `Bridge`, `BridgeError` (Task 7).
- Produces:
  - `final class ServerProxy: NSObject, URLSessionDataDelegate` with `static let prefix = "/__server"`, `init(configuration: URLSessionConfiguration = ServerProxy.defaultConfiguration)`, `private(set) var server: URL?`, `func setServer(_ origin: String) throws` (throws `BridgeError`), `static func target(for url: URL, server: URL) -> URL?`, `static func forwardedHeaders(_ headers: [String: String]) -> [String: String]`, `func start(_ task: WKURLSchemeTask)`, `func stop(_ task: WKURLSchemeTask)`.
  - `AppSchemeHandler.init(root: URL, proxy: ServerProxy)`.
  - Bridge method `setServer({ origin })` → `null`; error `failed` for a bad origin.

- [ ] **Step 1: Write the WebView test (this is the body spike)**

`ui/ios/App/AppTests/SchemeHandlerWebViewTests.swift` — a hosted test that runs a real WKWebView `fetch` POST through the scheme handler and a stubbed URLSession:

```swift
import XCTest
import WebKit
@testable import App

/// Answers every request with its own body, in two chunks.
final class EchoProtocol: URLProtocol {
    static var lastRequest: URLRequest?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                body.append(buffer, count: n)
            }
            stream.close()
        }
        EchoProtocol.lastRequest = request
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "text/plain"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("echo:".utf8))
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class SchemeHandlerWebViewTests: XCTestCase {
    func testFetchPostReachesTheServerWithItsBody() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("<html><body>t</body></html>".utf8).write(to: root.appendingPathComponent("index.html"))

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [EchoProtocol.self]
        let proxy = ServerProxy(configuration: config)
        try proxy.setServer("https://rc.example.com")
        let handler = AppSchemeHandler(root: root, proxy: proxy)

        let webConfig = WKWebViewConfiguration()
        webConfig.setURLSchemeHandler(handler, forURLScheme: AppSchemeHandler.scheme)
        let webView = await WKWebView(frame: .zero, configuration: webConfig)
        let loaded = expectation(description: "loaded")
        let delegate = LoadDelegate { loaded.fulfill() }
        await MainActor.run { webView.navigationDelegate = delegate }
        _ = await webView.load(URLRequest(url: URL(string: "opencode-rc://localhost/")!))
        await fulfillment(of: [loaded], timeout: 10)

        let result = try await webView.callAsyncJavaScript(
            "const r = await fetch('/__server/api/x?y=1', {method: 'POST', headers: {authorization: 'Bearer t'}, body: 'hello'}); return await r.text()",
            contentWorld: .page)
        XCTAssertEqual(result as? String, "echo:hello")
        XCTAssertEqual(EchoProtocol.lastRequest?.url?.absoluteString, "https://rc.example.com/api/x?y=1")
        XCTAssertEqual(EchoProtocol.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(EchoProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer t")
    }
}

final class LoadDelegate: NSObject, WKNavigationDelegate {
    let done: () -> Void
    init(_ done: @escaping () -> Void) { self.done = done }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done() }
}
```

`ui/ios/App/AppTests/ServerProxyTests.swift`:

```swift
import XCTest
import WebKit
@testable import App

final class FakeSchemeTask: NSObject, WKURLSchemeTask {
    let request: URLRequest
    var response: URLResponse?
    var chunks: [Data] = []
    var finished = false
    var error: Error?
    var onFinish: (() -> Void)?
    init(_ url: String, method: String = "GET", body: Data? = nil) {
        var r = URLRequest(url: URL(string: url)!)
        r.httpMethod = method
        r.httpBody = body
        request = r
    }
    func didReceive(_ response: URLResponse) { self.response = response }
    func didReceive(_ data: Data) { chunks.append(data) }
    func didFinish() { finished = true; onFinish?() }
    func didFailWithError(_ error: Error) { self.error = error; onFinish?() }
}

final class ServerProxyTests: XCTestCase {
    let server = URL(string: "https://rc.example.com:8443")!

    func testMapsThePathAndQuery() {
        XCTAssertEqual(ServerProxy.target(for: URL(string: "opencode-rc://localhost/__server/api/me?a=1&b=2")!, server: server)?.absoluteString,
                       "https://rc.example.com:8443/api/me?a=1&b=2")
        XCTAssertEqual(ServerProxy.target(for: URL(string: "opencode-rc://localhost/__server")!, server: server)?.absoluteString,
                       "https://rc.example.com:8443/")
        XCTAssertNil(ServerProxy.target(for: URL(string: "opencode-rc://localhost/assets/a.js")!, server: server))
    }

    func testDropsHeadersThatBelongToTheWebView() {
        let out = ServerProxy.forwardedHeaders(["Origin": "opencode-rc://localhost", "Host": "localhost",
                                                "Cookie": "a=b", "Authorization": "Bearer t", "Accept": "text/event-stream"])
        XCTAssertEqual(out, ["Authorization": "Bearer t", "Accept": "text/event-stream"])
    }

    func testAcceptsOnlyAnHttpOrigin() throws {
        let proxy = ServerProxy()
        try proxy.setServer("https://rc.example.com:8443/")
        XCTAssertEqual(proxy.server?.absoluteString, "https://rc.example.com:8443")
        XCTAssertThrowsError(try proxy.setServer("ftp://rc.example.com"))
        XCTAssertThrowsError(try proxy.setServer("https://rc.example.com/path"))
        XCTAssertThrowsError(try proxy.setServer("not a url"))
    }

    func testStreamsChunksAsTheyArrive() {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [EchoProtocol.self]
        let proxy = ServerProxy(configuration: config)
        try? proxy.setServer("https://rc.example.com")
        let task = FakeSchemeTask("opencode-rc://localhost/__server/x", method: "POST", body: Data("abc".utf8))
        let done = expectation(description: "finished")
        task.onFinish = { done.fulfill() }
        proxy.start(task)
        wait(for: [done], timeout: 5)
        XCTAssertTrue(task.finished)
        XCTAssertEqual(task.chunks.count, 2)
        XCTAssertEqual(task.chunks.reduce(Data(), +), Data("echo:abc".utf8))
        XCTAssertEqual((task.response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(task.response?.url?.absoluteString, "opencode-rc://localhost/__server/x")
    }

    func testAnswers502WithoutAServer() {
        let proxy = ServerProxy()
        let task = FakeSchemeTask("opencode-rc://localhost/__server/x")
        proxy.start(task)
        XCTAssertEqual((task.response as? HTTPURLResponse)?.statusCode, 502)
        XCTAssertTrue(task.finished)
    }
}
```

- [ ] **Step 2: Implement `ServerProxy.swift`**

```swift
import WebKit

/// Forwards opencode-rc://localhost/__server/<path> to the configured server with URLSession and
/// streams the response back chunk by chunk, so SSE works. URLSession traffic is the app's own, so
/// a per-app VPN carries it. Only the one server origin is reachable; no cookies (bearer tokens).
final class ServerProxy: NSObject, URLSessionDataDelegate {
    static let prefix = "/__server"
    static var defaultConfiguration: URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        // SSE streams stay open; these are idle limits, as long as a WebView's.
        c.timeoutIntervalForRequest = 24 * 3600
        c.timeoutIntervalForResource = 7 * 24 * 3600
        return c
    }
    private static let dropped: Set<String> = ["origin", "host", "cookie", "content-length"]

    private(set) var server: URL?
    private lazy var session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    private let configuration: URLSessionConfiguration
    private var schemeTasks: [Int: WKURLSchemeTask] = [:]   // URLSessionTask id → scheme task
    private var stopped = Set<ObjectIdentifier>()

    init(configuration: URLSessionConfiguration = ServerProxy.defaultConfiguration) {
        self.configuration = configuration
    }

    func setServer(_ origin: String) throws {
        guard let url = URL(string: origin), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host, url.path.isEmpty || url.path == "/", url.query == nil else {
            throw BridgeError.failed("bad server origin")
        }
        server = URL(string: "\(scheme)://\(host)\(url.port.map { ":\($0)" } ?? "")")
    }

    static func target(for url: URL, server: URL) -> URL? {
        guard url.path == prefix || url.path.hasPrefix(prefix + "/") else { return nil }
        var parts = URLComponents(url: server, resolvingAgainstBaseURL: false)!
        let rest = String(url.path.dropFirst(prefix.count))
        parts.percentEncodedPath = rest.isEmpty ? "/" : (URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .percentEncodedPath.dropFirst(prefix.count)).map(String.init) ?? rest
        parts.percentEncodedQuery = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery
        return parts.url
    }

    static func forwardedHeaders(_ headers: [String: String]) -> [String: String] {
        headers.filter { !dropped.contains($0.key.lowercased()) }
    }

    func start(_ task: WKURLSchemeTask) {
        guard let url = task.request.url, let server, let target = ServerProxy.target(for: url, server: server) else {
            fail(task, status: 502)
            return
        }
        var request = URLRequest(url: target)
        request.httpMethod = task.request.httpMethod ?? "GET"
        for (k, v) in ServerProxy.forwardedHeaders(task.request.allHTTPHeaderFields ?? [:]) {
            request.setValue(v, forHTTPHeaderField: k)
        }
        request.httpBody = ServerProxy.body(of: task.request)
        let dataTask = session.dataTask(with: request)
        schemeTasks[dataTask.taskIdentifier] = task
        dataTask.resume()
    }

    func stop(_ task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
        for (id, t) in schemeTasks where t === task {
            schemeTasks[id] = nil
            session.getAllTasks { $0.first { $0.taskIdentifier == id }?.cancel() }
        }
    }

    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        var data = Data()
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }

    private func live(_ id: Int) -> WKURLSchemeTask? {
        guard let task = schemeTasks[id], !stopped.contains(ObjectIdentifier(task)) else { return nil }
        return task
    }

    private func fail(_ task: WKURLSchemeTask, status: Int) {
        guard let url = task.request.url else { return }
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "0"])!)
        task.didFinish()
    }

    // A redirect to another origin is refused (502); same-origin redirects are followed.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        let same = request.url?.scheme == server?.scheme && request.url?.host == server?.host && request.url?.port == server?.port
        if same { completionHandler(request); return }
        completionHandler(nil)
        task.cancel()
        if let schemeTask = live(task.taskIdentifier) {
            schemeTasks[task.taskIdentifier] = nil
            fail(schemeTask, status: 502)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let schemeTask = live(dataTask.taskIdentifier), let url = schemeTask.request.url,
              let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields { if let k = k as? String, let v = v as? String { headers[k] = v } }
        schemeTask.didReceive(HTTPURLResponse(url: url, statusCode: http.statusCode, httpVersion: "HTTP/1.1", headerFields: headers)!)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        live(dataTask.taskIdentifier)?.didReceive(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let schemeTask = live(task.taskIdentifier) else { return }
        schemeTasks[task.taskIdentifier] = nil
        if let error { schemeTask.didFailWithError(error) } else { schemeTask.didFinish() }
    }
}
```

`AppSchemeHandler.swift`: change the doc comment to "Serves opencode-rc://localhost: the bundled web UI from App/public, and /__server/... through ServerProxy. The WebView itself makes no network requests."; add `let proxy: ServerProxy`, `init(root: URL, proxy: ServerProxy)`; at the top of `start`: `if url.path == ServerProxy.prefix || url.path.hasPrefix(ServerProxy.prefix + "/") { proxy.start(task); return }`; `stop` calls `proxy.stop(task)`.

`WebViewController.swift`: add `let proxy = ServerProxy()`; the scheme handler is `AppSchemeHandler(root: ..., proxy: proxy)`; in `loadView` after creating the bridge:

```swift
        bridge.register("setServer") { [proxy] args, reply in
            do {
                try proxy.setServer(args["origin"] as? String ?? "")
                reply(.success(nil))
            } catch let error as BridgeError {
                reply(.failure(error))
            } catch {
                reply(.failure(.failed("bad server origin")))
            }
        }
```

Add `ServerProxy.swift` to the App target and the two test files to `AppTests` (Ruby script as in Task 7).

- [ ] **Step 3: Run the tests on the Mac**

Run the `xcodebuild test` command from Task 7 Step 4.
Expected: all pass, including `testFetchPostReachesTheServerWithItsBody`.

**If `testFetchPostReachesTheServerWithItsBody` fails only because the echoed body is empty** (WebKit did not hand the body to the scheme handler), apply the fallback and run again:
- `ui/src/native-transport.ts`: in the fetch patch, for a request with a body, call `const bodyId = \`b-${++bodyCount}\`; await nativeCall("httpBody", { id: bodyId, base64: bytesToBase64(new Uint8Array(body)) })`, send the request without `body`, and add the header `x-rc-body: <bodyId>`; add a vitest case for it.
- `ServerProxy.swift`: keep `private var bodies: [String: Data] = [:]`; register bridge method `httpBody({ id, base64 })` that stores the decoded data; in `start`, if the header `x-rc-body` is present, use and remove `bodies[id]` as the body and drop the header before forwarding.
- Record the outcome in the commit message body.

- [ ] **Step 4: Commit**

```bash
git add -A ui/ios
git commit -m "feat(ios): forward server requests with URLSession"
```

---

### Task 9: iOS WebSockets through the bridge

**Files:**
- Create: `ui/ios/App/App/WebSocketBridge.swift`
- Modify: `ui/ios/App/App/WebViewController.swift`, `project.pbxproj`
- Test: `ui/ios/App/AppTests/WebSocketBridgeTests.swift`

**Interfaces:**
- Consumes: `ServerProxy.server`, `Bridge.emit`, `BridgeError`.
- Produces: `final class WebSocketBridge: NSObject, URLSessionWebSocketDelegate` with `init(proxy: ServerProxy, emit: @escaping (String, [String: Any]) -> Void)`, `func open(id: String, url: String, protocols: [String]) throws`, `func send(id: String, text: String?, base64: String?)`, `func close(id: String, code: Int, reason: String)`, `static func allowed(_ url: URL, server: URL) -> Bool`. Bridge methods `wsOpen`, `wsSend`, `wsClose`; events as in Task 5.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import App

final class WebSocketBridgeTests: XCTestCase {
    let server = URL(string: "https://rc.example.com:8443")!

    func testAllowsOnlyTheServersSocketOrigin() {
        XCTAssertTrue(WebSocketBridge.allowed(URL(string: "wss://rc.example.com:8443/proxy/s/pty?access_token=t")!, server: server))
        XCTAssertFalse(WebSocketBridge.allowed(URL(string: "ws://rc.example.com:8443/x")!, server: server))
        XCTAssertFalse(WebSocketBridge.allowed(URL(string: "wss://rc.example.com/x")!, server: server))
        XCTAssertFalse(WebSocketBridge.allowed(URL(string: "wss://evil.example.com:8443/x")!, server: server))
        XCTAssertTrue(WebSocketBridge.allowed(URL(string: "ws://10.0.0.5:12029/x")!, server: URL(string: "http://10.0.0.5:12029")!))
    }

    func testRefusesToOpenWithoutAServer() {
        let bridge = WebSocketBridge(proxy: ServerProxy(), emit: { _, _ in })
        XCTAssertThrowsError(try bridge.open(id: "1", url: "wss://rc.example.com/x", protocols: []))
    }
}
```

- [ ] **Step 2: Implement `WebSocketBridge.swift`**

```swift
import Foundation

/// WebSockets for the web UI (ui/src/native-transport.ts) through URLSessionWebSocketTask, so a
/// per-app VPN carries them. Only the server's ws(s) origin is reachable.
final class WebSocketBridge: NSObject, URLSessionWebSocketDelegate {
    private let proxy: ServerProxy
    private let emit: (String, [String: Any]) -> Void
    private lazy var session = URLSession(configuration: ServerProxy.defaultConfiguration, delegate: self, delegateQueue: .main)
    private var sockets: [String: URLSessionWebSocketTask] = [:]
    private var ids: [Int: String] = [:]

    init(proxy: ServerProxy, emit: @escaping (String, [String: Any]) -> Void) {
        self.proxy = proxy
        self.emit = emit
    }

    static func allowed(_ url: URL, server: URL) -> Bool {
        let expected = server.scheme == "https" ? "wss" : "ws"
        return url.scheme == expected && url.host == server.host && url.port == server.port
    }

    func open(id: String, url: String, protocols: [String]) throws {
        guard let server = proxy.server, let target = URL(string: url), WebSocketBridge.allowed(target, server: server) else {
            throw BridgeError.failed("socket not allowed")
        }
        let task = protocols.isEmpty ? session.webSocketTask(with: target) : session.webSocketTask(with: target, protocols: protocols)
        sockets[id] = task
        ids[task.taskIdentifier] = id
        receive(id, task)
        task.resume()
    }

    func send(id: String, text: String?, base64: String?) {
        guard let task = sockets[id] else { return }
        let message: URLSessionWebSocketTask.Message
        if let text { message = .string(text) }
        else if let base64, let data = Data(base64Encoded: base64) { message = .data(data) }
        else { return }
        task.send(message) { [weak self] error in
            if let error { self?.emit("ws.error", ["id": id, "message": error.localizedDescription]) }
        }
    }

    func close(id: String, code: Int, reason: String) {
        sockets[id]?.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure,
                            reason: reason.data(using: .utf8))
    }

    private func receive(_ id: String, _ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, self.sockets[id] === task else { return }
            switch result {
            case .success(.string(let text)): self.emit("ws.message", ["id": id, "text": text])
            case .success(.data(let data)): self.emit("ws.message", ["id": id, "base64": data.base64EncodedString()])
            case .success: break
            case .failure: return // didCompleteWithError reports it
            }
            self.receive(id, task)
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard let id = ids[webSocketTask.taskIdentifier] else { return }
        emit("ws.open", ["id": id, "protocol": `protocol` ?? ""])
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(webSocketTask, code: closeCode.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) } ?? "", clean: true)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        if let id = ids[task.taskIdentifier] { emit("ws.error", ["id": id, "message": error.localizedDescription]) }
        finish(task, code: 1006, reason: "", clean: false)
    }

    private func finish(_ task: URLSessionTask, code: Int, reason: String, clean: Bool) {
        guard let id = ids.removeValue(forKey: task.taskIdentifier) else { return }
        sockets[id] = nil
        emit("ws.close", ["id": id, "code": code, "reason": reason, "wasClean": clean])
    }
}
```

`WebViewController.swift`: add `private lazy var sockets = WebSocketBridge(proxy: proxy, emit: { [weak bridge] e, d in bridge?.emit(e, d) })` and register in `loadView`:

```swift
        bridge.register("wsOpen") { [unowned self] args, reply in
            do {
                try sockets.open(id: args["id"] as? String ?? "", url: args["url"] as? String ?? "",
                                 protocols: args["protocols"] as? [String] ?? [])
                reply(.success(nil))
            } catch let error as BridgeError {
                reply(.failure(error))
            } catch {
                reply(.failure(.failed("socket failed")))
            }
        }
        bridge.register("wsSend") { [unowned self] args, reply in
            sockets.send(id: args["id"] as? String ?? "", text: args["text"] as? String, base64: args["base64"] as? String)
            reply(.success(nil))
        }
        bridge.register("wsClose") { [unowned self] args, reply in
            sockets.close(id: args["id"] as? String ?? "", code: args["code"] as? Int ?? 1000, reason: args["reason"] as? String ?? "")
            reply(.success(nil))
        }
```

Add the files to their targets (Ruby script).

- [ ] **Step 3: Run the tests on the Mac**

Run the Task 7 `xcodebuild test` command. Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add -A ui/ios
git commit -m "feat(ios): WebSockets through URLSession"
```

---

### Task 10: iOS sign-in in SFSafariViewController

**Files:**
- Create: `ui/ios/App/App/SignIn.swift`
- Modify: `ui/ios/App/App/SceneDelegate.swift`, `ui/ios/App/App/WebViewController.swift`, `ui/ios/App/App/Info.plist`, `project.pbxproj`
- Test: `ui/ios/App/AppTests/SignInTests.swift`

**Interfaces:**
- Consumes: `Bridge`, `BridgeError`.
- Produces: `final class SignIn: NSObject, SFSafariViewControllerDelegate` with `static let shared`, `init(present: @escaping (UIViewController) -> Void, dismiss: @escaping (UIViewController) -> Void)`, `func start(url: URL, callbackScheme: String, completion: @escaping (Result<String, BridgeError>) -> Void)`, `@discardableResult func handle(_ url: URL) -> Bool`. Bridge method `signIn({ url, callbackScheme })` → `{ url }`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import App

final class SignInTests: XCTestCase {
    var presented: [UIViewController] = []
    var dismissed: [UIViewController] = []
    lazy var signIn = SignIn(present: { self.presented.append($0) }, dismiss: { self.dismissed.append($0) })

    func testResolvesWithTheCallbackAndClosesTheView() {
        var result: Result<String, BridgeError>?
        signIn.start(url: URL(string: "https://idp.example.com/authorize?x=1")!, callbackScheme: "com.opencode.rc") { result = $0 }
        XCTAssertEqual(presented.count, 1)
        XCTAssertFalse(signIn.handle(URL(string: "other.scheme:/x")!))
        XCTAssertTrue(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c&state=s")!))
        XCTAssertEqual(try? result?.get(), "com.opencode.rc:/auth/callback?code=c&state=s")
        XCTAssertEqual(dismissed.count, 1)
        XCTAssertFalse(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c")!))
    }

    func testDoneButtonCancels() {
        var result: Result<String, BridgeError>?
        signIn.start(url: URL(string: "https://idp.example.com/a")!, callbackScheme: "com.opencode.rc") { result = $0 }
        signIn.safariViewControllerDidFinish(presented[0] as! SFSafariViewController)
        if case .failure(let e) = result { XCTAssertEqual(e.code, "cancelled") } else { XCTFail("not cancelled") }
    }

    func testANewSignInCancelsThePendingOne() {
        var first: Result<String, BridgeError>?
        signIn.start(url: URL(string: "https://idp.example.com/a")!, callbackScheme: "com.opencode.rc") { first = $0 }
        signIn.start(url: URL(string: "https://idp.example.com/b")!, callbackScheme: "com.opencode.rc") { _ in }
        if case .failure(let e) = first { XCTAssertEqual(e.code, "cancelled") } else { XCTFail("not cancelled") }
    }

    func testRefusesNonWebURLs() {
        var result: Result<String, BridgeError>?
        signIn.start(url: URL(string: "file:///etc/passwd")!, callbackScheme: "com.opencode.rc") { result = $0 }
        if case .failure(let e) = result { XCTAssertEqual(e.code, "failed") } else { XCTFail("not failed") }
        XCTAssertTrue(presented.isEmpty)
    }
}
```

Add `import SafariServices` at the top of the test file.

- [ ] **Step 2: Implement**

`ui/ios/App/App/SignIn.swift`:

```swift
import SafariServices
import UIKit

/// Sign-in in an SFSafariViewController (ui/src/auth.ts nativeLogin). It counts as Safari, so a
/// per-app VPN's Safari Domains apply to it; only the IdP loads in it. The IdP redirects to
/// com.opencode.rc:/auth/callback, which iOS hands to SceneDelegate, which calls handle(_:).
final class SignIn: NSObject, SFSafariViewControllerDelegate {
    static let shared = SignIn(
        present: { vc in UIApplication.shared.topViewController?.present(vc, animated: true) },
        dismiss: { vc in vc.dismiss(animated: true) })

    private let present: (UIViewController) -> Void
    private let dismiss: (UIViewController) -> Void
    private var completion: ((Result<String, BridgeError>) -> Void)?
    private var callbackScheme = ""
    private var view: SFSafariViewController?

    init(present: @escaping (UIViewController) -> Void, dismiss: @escaping (UIViewController) -> Void) {
        self.present = present
        self.dismiss = dismiss
    }

    func start(url: URL, callbackScheme: String, completion: @escaping (Result<String, BridgeError>) -> Void) {
        finish(.failure(.cancelled("superseded by a new sign-in")))
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? ""), !callbackScheme.isEmpty else {
            completion(.failure(.failed("bad sign-in URL")))
            return
        }
        self.completion = completion
        self.callbackScheme = callbackScheme.lowercased()
        let safari = SFSafariViewController(url: url)
        safari.delegate = self
        safari.dismissButtonStyle = .cancel
        view = safari
        present(safari)
    }

    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard completion != nil, url.scheme?.lowercased() == callbackScheme else { return false }
        finish(.success(url.absoluteString))
        return true
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        view = nil
        finish(.failure(.cancelled("sign-in cancelled")))
    }

    private func finish(_ result: Result<String, BridgeError>) {
        guard let completion else { return }
        self.completion = nil
        if let view { dismiss(view) }
        view = nil
        completion(result)
    }
}

extension UIApplication {
    var topViewController: UIViewController? {
        let scene = connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        var top = scene?.windows.first { $0.isKeyWindow }?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}
```

`SceneDelegate.swift`, add:

```swift
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts { SignIn.shared.handle(context.url) }
    }
```

`WebViewController.swift`, register in `loadView`:

```swift
        bridge.register("signIn") { args, reply in
            guard let url = URL(string: args["url"] as? String ?? "") else {
                reply(.failure(.failed("bad sign-in URL")))
                return
            }
            SignIn.shared.start(url: url, callbackScheme: args["callbackScheme"] as? String ?? "") { result in
                reply(result.map { ["url": $0] as Any? })
            }
        }
```

`Info.plist`, add before the closing `</dict>`:

```xml
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>com.opencode.rc.signin</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>com.opencode.rc</string>
			</array>
		</dict>
	</array>
```

Add `SignIn.swift` and `SignInTests.swift` to their targets.

- [ ] **Step 3: Run the tests on the Mac**

Run the Task 7 `xcodebuild test` command. Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add -A ui/ios
git commit -m "feat(ios): sign in with SFSafariViewController"
```

---

### Task 11: Android shell without Capacitor

**Files:**
- Create: `ui/android/app/src/main/java/com/opencode/rc/NavigationPolicy.java`, `BundlePaths.java`, `Bridge.java`, `SignIn.java`
- Modify: `ui/android/app/src/main/java/com/opencode/rc/MainActivity.java`, `ui/android/app/build.gradle`, `ui/android/settings.gradle`, `ui/android/build.gradle` (if it references Capacitor), `ui/android/app/src/main/AndroidManifest.xml`, `ui/android/.gitignore`
- Delete: `SystemAuthPlugin.java`, `ui/android/capacitor.settings.gradle`, `ui/android/app/capacitor.build.gradle`, `ui/android/capacitor-cordova-android-plugins/` (if tracked), `ui/android/app/src/main/res/xml/file_paths.xml`, `ui/android/app/src/test/java/com/getcapacitor/`, `ui/android/app/src/androidTest/java/com/getcapacitor/`
- Test: `ui/android/app/src/test/java/com/opencode/rc/NavigationPolicyTest.java`, `BundlePathsTest.java`, `BridgeTest.java`

**Interfaces:**
- Consumes: the Android wire protocol from Task 3 (`rcNativePort`, ids, `{id, result}`/`{id, error}`).
- Produces: `NavigationPolicy.decide(String url, boolean isMainFrame)` → `NavigationPolicy.Decision { ALLOW, OPEN_EXTERNALLY, CANCEL }`; `BundlePaths.resolve(String path, Predicate<String> exists)` → asset path or `null`; `Bridge.accepts(String origin, boolean isMainFrame)`; `Bridge.result(int id, JSONObject result)`, `Bridge.error(int id, String code, String message)` → JSON strings.

- [ ] **Step 1: Write the failing tests**

`NavigationPolicyTest.java`:

```java
package com.opencode.rc;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class NavigationPolicyTest {
    @Test public void allowsTheApp() {
        assertEquals(NavigationPolicy.Decision.ALLOW, NavigationPolicy.decide("https://localhost/s/x", true));
        assertEquals(NavigationPolicy.Decision.ALLOW, NavigationPolicy.decide("https://localhost/", false));
    }
    @Test public void opensEverythingElseOutside() {
        assertEquals(NavigationPolicy.Decision.OPEN_EXTERNALLY, NavigationPolicy.decide("https://example.com/", true));
        assertEquals(NavigationPolicy.Decision.OPEN_EXTERNALLY, NavigationPolicy.decide("http://localhost/", true));
        assertEquals(NavigationPolicy.Decision.OPEN_EXTERNALLY, NavigationPolicy.decide("https://localhost:8443/", true));
        assertEquals(NavigationPolicy.Decision.OPEN_EXTERNALLY, NavigationPolicy.decide("mailto:a@example.com", true));
    }
    @Test public void cancelsLocalOnlySchemesAndForeignSubframes() {
        assertEquals(NavigationPolicy.Decision.CANCEL, NavigationPolicy.decide("about:blank", true));
        assertEquals(NavigationPolicy.Decision.CANCEL, NavigationPolicy.decide("javascript:alert(1)", true));
        assertEquals(NavigationPolicy.Decision.CANCEL, NavigationPolicy.decide("https://example.com/", false));
        assertEquals(NavigationPolicy.Decision.ALLOW, NavigationPolicy.decide("about:blank", false));
        assertEquals(NavigationPolicy.Decision.CANCEL, NavigationPolicy.decide("not a url", true));
    }
}
```

`BundlePathsTest.java`:

```java
package com.opencode.rc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import java.util.Set;
import org.junit.Test;

public class BundlePathsTest {
    private final Set<String> files = Set.of("public/index.html", "public/assets/a.js", "public/v2/index.html");
    private String resolve(String p) { return BundlePaths.resolve(p, files::contains); }

    @Test public void servesFiles() {
        assertEquals("public/assets/a.js", resolve("/assets/a.js"));
        assertEquals("public/index.html", resolve("/"));
        assertEquals("public/v2/index.html", resolve("/v2/"));
    }
    @Test public void fallsBackToTheBuildsIndex() {
        assertEquals("public/index.html", resolve("/s/abc"));
        assertEquals("public/v2/index.html", resolve("/v2/s/abc"));
    }
    @Test public void rejectsMissingFilesAndTraversal() {
        assertNull(resolve("/assets/missing.js"));
        assertNull(resolve("/../secret.txt"));
        assertNull(resolve("/assets/../../x.txt"));
    }
}
```

`BridgeTest.java`:

```java
package com.opencode.rc;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class BridgeTest {
    @Test public void acceptsOnlyTheAppsMainFrame() {
        assertTrue(Bridge.accepts("https://localhost", true));
        assertFalse(Bridge.accepts("https://localhost", false));
        assertFalse(Bridge.accepts("https://evil.example.com", true));
        assertFalse(Bridge.accepts(null, true));
    }
    @Test public void formatsReplies() throws Exception {
        JSONObject ok = new JSONObject(Bridge.result(3, new JSONObject().put("url", "u")));
        assertEquals(3, ok.getInt("id"));
        assertEquals("u", ok.getJSONObject("result").getString("url"));
        JSONObject err = new JSONObject(Bridge.error(4, "cancelled", "closed"));
        assertEquals("cancelled", err.getJSONObject("error").getString("code"));
    }
}
```

- [ ] **Step 2: Implement**

`NavigationPolicy.java`:

```java
package com.opencode.rc;

import java.net.URI;

/** What the WebView may load: only the app. Other top-level loads open outside the app. */
final class NavigationPolicy {
    enum Decision { ALLOW, OPEN_EXTERNALLY, CANCEL }

    static final String ORIGIN = "https://localhost";

    private NavigationPolicy() {}

    static Decision decide(String url, boolean isMainFrame) {
        URI uri;
        try {
            uri = new URI(url);
        } catch (Exception e) {
            return Decision.CANCEL;
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (scheme.isEmpty()) return Decision.CANCEL;
        if (scheme.equals("https") && "localhost".equals(uri.getHost()) && uri.getPort() == -1) return Decision.ALLOW;
        if (!isMainFrame) return scheme.equals("about") ? Decision.ALLOW : Decision.CANCEL;
        switch (scheme) {
            case "about": case "blob": case "data": case "javascript": case "file": case "content":
                return Decision.CANCEL;
            default:
                return Decision.OPEN_EXTERNALLY;
        }
    }
}
```

`BundlePaths.java`:

```java
package com.opencode.rc;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;

/** Maps request paths to the bundled web UI in assets/public, with the SPA fallback. */
final class BundlePaths {
    private BundlePaths() {}

    /** The asset for a request path, or null (404). Any ".." segment is refused. */
    static String resolve(String path, Predicate<String> exists) {
        List<String> parts = new ArrayList<>();
        for (String part : path.split("/")) {
            if (part.equals("..")) return null;
            if (!part.isEmpty() && !part.equals(".")) parts.add(part);
        }
        String rel = String.join("/", parts);
        boolean dir = rel.isEmpty() || path.endsWith("/");
        String file = "public/" + (dir ? (rel.isEmpty() ? "" : rel + "/") + "index.html" : rel);
        if (exists.test(file)) return file;
        if (!dir && parts.get(parts.size() - 1).contains(".")) return null;
        if (path.startsWith("/v2/") && exists.test("public/v2/index.html")) return "public/v2/index.html";
        return "public/index.html";
    }
}
```

`Bridge.java`:

```java
package com.opencode.rc;

import android.net.Uri;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The JS ↔ native bridge (ui/src/native.ts): a WebMessageListener object "rcNativePort",
 * injected only into frames of the app origin. Messages are JSON {id, method, args}; replies
 * {id, result} or {id, error: {code, message}}.
 */
final class Bridge implements WebViewCompat.WebMessageListener {
    static final String NAME = "rcNativePort";
    private final SignIn signIn;

    Bridge(SignIn signIn) {
        this.signIn = signIn;
    }

    static boolean accepts(String origin, boolean isMainFrame) {
        return isMainFrame && NavigationPolicy.ORIGIN.equals(origin);
    }

    static String result(int id, JSONObject result) {
        try {
            return new JSONObject().put("id", id).put("result", result == null ? JSONObject.NULL : result).toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    static String error(int id, String code, String message) {
        try {
            return new JSONObject().put("id", id)
                    .put("error", new JSONObject().put("code", code).put("message", message)).toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public void onPostMessage(@NonNull WebView view, @NonNull WebMessageCompat message, @NonNull Uri sourceOrigin,
                              boolean isMainFrame, @NonNull JavaScriptReplyProxy reply) {
        String origin = sourceOrigin.getScheme() + "://" + sourceOrigin.getAuthority();
        if (!accepts(origin, isMainFrame) || message.getData() == null) return;
        int id;
        String method;
        JSONObject args;
        try {
            JSONObject msg = new JSONObject(message.getData());
            id = msg.getInt("id");
            method = msg.getString("method");
            args = msg.optJSONObject("args") == null ? new JSONObject() : msg.optJSONObject("args");
        } catch (JSONException e) {
            return;
        }
        if (!method.equals("signIn")) {
            reply.postMessage(error(id, "failed", "unknown method " + method));
            return;
        }
        signIn.start(args.optString("url"), args.optString("callbackScheme"), new SignIn.Callback() {
            @Override public void onResult(String url) {
                try {
                    reply.postMessage(result(id, new JSONObject().put("url", url)));
                } catch (JSONException e) {
                    reply.postMessage(error(id, "failed", "bad callback"));
                }
            }
            @Override public void onError(String code, String text) {
                reply.postMessage(error(id, code, text));
            }
        });
    }
}
```

`SignIn.java` (today's plugin logic without Capacitor):

```java
package com.opencode.rc;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.net.Uri;
import androidx.browser.customtabs.CustomTabsIntent;

/**
 * Sign-in in a Custom Tab (RFC 8252); only the IdP loads in it. The IdP redirects to
 * com.opencode.rc:/auth/callback, which MainActivity receives as a new intent. Main thread only.
 * If the OS kills the app while the tab is open, the callback finds no pending sign-in and is
 * ignored (the user signs in again).
 */
final class SignIn {
    interface Callback {
        void onResult(String url);
        void onError(String code, String message);
    }

    private final Activity activity;
    private Callback pending;
    private String callbackScheme;

    SignIn(Activity activity) {
        this.activity = activity;
    }

    void start(String url, String scheme, Callback callback) {
        if (pending != null) {
            Callback previous = pending;
            pending = null;
            previous.onError("cancelled", "superseded by a new sign-in");
        }
        Uri uri = Uri.parse(url == null ? "" : url);
        if (scheme == null || scheme.isEmpty() || !("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))) {
            callback.onError("failed", "bad sign-in URL");
            return;
        }
        pending = callback;
        callbackScheme = scheme;
        try {
            new CustomTabsIntent.Builder().build().launchUrl(activity, uri);
        } catch (ActivityNotFoundException e) {
            pending = null;
            callback.onError("failed", "no browser available");
        }
    }

    /** From onNewIntent. True when it was the sign-in callback. */
    boolean onCallback(Uri data) {
        if (pending == null || data == null || !callbackScheme.equalsIgnoreCase(data.getScheme())) return false;
        Callback callback = pending;
        pending = null;
        callback.onResult(data.toString());
        return true;
    }

    /** From onResume: back in the app without a callback (onNewIntent runs first) means the tab was closed. */
    void onResume() {
        if (pending == null) return;
        Callback callback = pending;
        pending = null;
        callback.onError("cancelled", "sign-in cancelled");
    }
}
```

`MainActivity.java`:

```java
package com.opencode.rc;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;

/** The app: one WebView showing the bundled web UI from https://localhost (assets/public). */
public class MainActivity extends AppCompatActivity {
    private WebView webView;
    private SignIn signIn;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        setTheme(R.style.AppTheme_NoActionBar);
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportMultipleWindows(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .setDomain("localhost")
                .addPathHandler("/", this::serveBundle)
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !handle(request.getUrl().toString(), request.isForMainFrame());
            }
        });
        // target=_blank and window.open: never a second WebView; open the URL outside.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView probe = new WebView(MainActivity.this);
                probe.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        handle(request.getUrl().toString(), true);
                        v.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(probe);
                resultMsg.sendToTarget();
                return true;
            }
        });

        signIn = new SignIn(this);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, Bridge.NAME,
                    Collections.singleton(NavigationPolicy.ORIGIN), new Bridge(signIn));
        }

        // The WebView sits between the system bars, and above the keyboard while it is open, so the
        // page (and its composer) shrinks to the visible area.
        ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(), (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) webView.getLayoutParams();
            lp.topMargin = bars.top;
            lp.bottomMargin = Math.max(bars.bottom, ime.bottom);
            lp.leftMargin = bars.left;
            lp.rightMargin = bars.right;
            webView.setLayoutParams(lp);
            return WindowInsetsCompat.CONSUMED;
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });

        webView.loadUrl(NavigationPolicy.ORIGIN + "/");
    }

    /** True when the WebView may load the URL; otherwise it is opened outside or dropped. */
    private boolean handle(String url, boolean isMainFrame) {
        switch (NavigationPolicy.decide(url, isMainFrame)) {
            case ALLOW:
                return true;
            case OPEN_EXTERNALLY:
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (ActivityNotFoundException ignored) {
                    // No app for this link.
                }
                return false;
            default:
                return false;
        }
    }

    private WebResourceResponse serveBundle(String path) {
        String file = BundlePaths.resolve("/" + path, name -> {
            try (InputStream in = getAssets().open(name)) {
                return true;
            } catch (IOException e) {
                return false;
            }
        });
        if (file == null) return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", Collections.emptyMap(), null);
        try {
            return new WebResourceResponse(mimeType(file), null, getAssets().open(file));
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", Collections.emptyMap(), null);
        }
    }

    private static String mimeType(String file) {
        String ext = file.substring(file.lastIndexOf('.') + 1).toLowerCase();
        switch (ext) {
            case "html": return "text/html";
            case "js": case "mjs": return "text/javascript";
            case "css": return "text/css";
            case "json": case "map": return "application/json";
            case "svg": return "image/svg+xml";
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "ico": return "image/x-icon";
            case "webp": return "image/webp";
            case "woff": return "font/woff";
            case "woff2": return "font/woff2";
            case "ttf": return "font/ttf";
            case "wasm": return "application/wasm";
            case "txt": return "text/plain";
            default: return "application/octet-stream";
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        signIn.onCallback(intent.getData());
    }

    @Override
    protected void onResume() {
        super.onResume();
        signIn.onResume();
    }
}
```

Gradle:
- `ui/android/settings.gradle`: keep only `include ':app'`.
- `ui/android/app/build.gradle`: delete the `repositories { flatDir ... }` block, `implementation project(':capacitor-android')`, `implementation project(':capacitor-cordova-android-plugins')`, `apply from: 'capacitor.build.gradle'`, and the `google-services` `try` block; add `implementation "androidx.webkit:webkit:$androidxWebkitVersion"` and `testImplementation "org.json:json:20240303"`.
- `ui/android/build.gradle`: remove any Capacitor reference (`grep -n capacitor ui/android/build.gradle`).
- Delete `capacitor.settings.gradle`, `app/capacitor.build.gradle`, the `com/getcapacitor` test folders, `res/xml/file_paths.xml`; in `AndroidManifest.xml` delete the `<provider>` block and change the comment on the callback filter to `<!-- Sign-in callback from the Custom Tab (SignIn.java). -->`.
- `ui/android/.gitignore`: drop the Capacitor lines (`capacitor-cordova-android-plugins`, `app/src/main/assets/capacitor.config.json`, `app/src/main/assets/capacitor.plugins.json`); keep `app/src/main/assets/public`.

- [ ] **Step 3: Run the tests and build**

Run: `cd ui && bun run build && bun run sync:android && cd android && ./gradlew test assembleDebug`
Expected: BUILD SUCCESSFUL; `NavigationPolicyTest`, `BundlePathsTest`, `BridgeTest` pass. `grep -rn "getcapacitor\|capacitor" ui/android --include=*.java --include=*.gradle --include=*.xml` prints nothing.

- [ ] **Step 4: Commit**

```bash
git add -A ui/android
git commit -m "feat(android): plain WebView shell without Capacitor"
```

---

### Task 12: Remove Capacitor packages; offline bundle tooling; CI

**Files:**
- Modify: `ui/package.json`, `ui/bun.lock`, `ui/ios-offline/bundle.sh`, `ui/ios-offline/verify.sh`, `ui/ios-offline/set-server-url.sh`, `ui/ios-offline/set-server-url.test.ts`, `ui/ios-offline/presets.test.ts` (if it mentions Capacitor), `.github/workflows/ios.yml`, `.github/workflows/ios-offline.yml`, `.github/workflows/android.yml`

**Interfaces:**
- Consumes: `bun run sync:ios|sync:android` (Task 6); the Capacitor-free projects (Tasks 7–11).

- [ ] **Step 1: Update the set-server-url test first**

In `ui/ios-offline/set-server-url.test.ts`: delete the `capconfig` helper and the `capacitor.config.json` copy in `beforeEach`; in every bundle-id test, drop the assertions on `capacitor.config.json` `appId`. Add `.tests` handling:

```ts
  it("gives the unit tests <id>.tests", () => {
    expect(run("--bundle-id", "com.corp.opencode").status).toBe(0)
    expect(bundleIds()).toContain('"com.corp.opencode.tests"')
    expect(bundleIds()).toContain('"com.corp.opencode.uitests"')
  })

  it("rejects an id that ends in .tests", () => {
    expect(run("--bundle-id", "com.corp.tests").status).toBe(2)
  })
```

The fixture copies the real pbxproj, which now has the `AppTests` target (`com.opencode.rc.tests`).

Run: `cd ui && bunx vitest run ios-offline/set-server-url.test.ts`
Expected: FAIL (the script still requires `capacitor.config.json` and maps `.tests` to the app id).

- [ ] **Step 2: Update the scripts**

`set-server-url.sh`:
- Delete `capconfig=App/capacitor.config.json`, its `grep -q '"appId":'` check, and the `perl` line that edits it.
- Change the bundle-id validation case `*.uitests)` to `*.uitests|*.tests)` and its comment to `# The test targets take <id>.tests and <id>.uitests, so an id of that form would be read back as theirs.`
- Change the pbxproj perl expression to keep both suffixes:

```sh
  ID="$bundle_id" perl -pi -e '
    s{PRODUCT_BUNDLE_IDENTIFIER = "?([^";]*)"?;}{
      "PRODUCT_BUNDLE_IDENTIFIER = \"" . ($1 =~ /(\.uitests|\.tests)$/ ? "$ENV{ID}$1" : $ENV{ID}) . "\";"
    }ge;
  ' "$pbx"
```

- Update the header comment line `# --bundle-id sets the app's bundle identifier (the UI tests get <id>.uitests).` to `(the test targets get <id>.tests and <id>.uitests)`.

`bundle.sh`:
- Delete the whole `capacitor-swift-pm` section (from `# capacitor-swift-pm: one exact-version dependency` through the `grep -q '\.package(path: ...` check) and the `capver`/`cap` variables.
- Add, where that section was:

```sh
# Builds offline: the project must have no Swift package dependencies.
if grep -q 'XCRemoteSwiftPackageReference\|XCLocalSwiftPackageReference' "$dest/App/App.xcodeproj/project.pbxproj"; then
  fail "App.xcodeproj has Swift package dependencies"
fi
```

- Change the precondition message `build the UI and run npx cap sync ios first` to `build the UI and run bun run sync:ios first`, and the header comment's `npx cap sync ios` likewise.
- In the generated README text, replace the two lines about Capacitor (`internet: the web UI is built in ... and Capacitor $capver is included` / `(\`capacitor-swift-pm/\`, MIT, ...)`) with `internet: the web UI is built in (\`App/App/public\`) and the project has no dependencies.`

`verify.sh`: delete the `[ -d "$dir/capacitor-swift-pm" ] || fail ...` line; keep the rest.

Read `.github/workflows/ios-offline.yml` and `ui/ios-offline/Dockerfile` for other Capacitor steps and remove them.

- [ ] **Step 3: Remove the Capacitor packages**

In `ui/package.json`, delete `@capacitor/core` from `dependencies` and `@capacitor/android`, `@capacitor/cli`, `@capacitor/ios` from `devDependencies`. Run `cd ui && bun install`. Then `grep -rn "capacitor" ui --include=*.ts --include=*.tsx --include=*.json --include=*.sh -i | grep -v node_modules | grep -v bun.lock` and fix what remains (comments included), except historical text in `docs/superpowers/` files.

- [ ] **Step 4: CI**

`.github/workflows/ios.yml`: replace the step `Sync iOS project` command `cd ui && npx cap sync ios` with `cd ui && bun run sync:ios`; change the comment above `Build and test` to `# Unsigned, in the Simulator: compiles the app and runs AppTests and the launch test (AppUITests).`

`.github/workflows/ios-offline.yml`: `cd src/ui && npx cap sync ios` → `cd src/ui && bun run sync:ios`; update the header comment that says the bundle includes Capacitor.

`.github/workflows/android.yml`: `cd ui && npx cap sync android` → `cd ui && bun run sync:android`; delete the three lines that copy `capacitor-android` and edit `capacitor.settings.gradle` in "Prepare releases/android"; change `./gradlew assembleDebug` to `./gradlew test assembleDebug`.

- [ ] **Step 5: Run the checks**

Run:
```bash
cd ui && bunx vitest run ios-offline && bun run test && bun run typecheck
cd .. && make unit-test
```
Expected: all pass. On the Mac: `ui/ios-offline/bundle.sh` for the `default` preset into a temp dir, then `ui/ios-offline/verify.sh` on it (as `ios-offline.yml` does). Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add -A ui .github
git commit -m "build: drop Capacitor from the UI, the offline bundle and CI"
```

---

### Task 13: Docs and full verification

**Files:**
- Modify: `AGENTS.md`, `README.md`, `docs/ios-app.md`, `ui/ios/README.md`, `ui/android/README.md`, `docs/superpowers/specs/2026-11-03-mobile-shell-without-capacitor-design.md` (Status)

- [ ] **Step 1: Update the docs**

- `AGENTS.md`, Building: replace the paragraph that starts "The iOS/Android apps sign in outside their WebView" with:

```markdown
The iOS and Android apps are plain native shells around one WebView that loads only the bundled
UI (iOS `opencode-rc://localhost`, Android `https://localhost`); other links open in the system
browser. They sign in as a public OIDC client with PKCE in the system browser view (iOS
SFSafariViewController, Android Custom Tab), which loads only the IdP; the IdP redirects to
`com.opencode.rc:/auth/callback` and the API exchanges the code (`/auth/app-token`, needs
`OIDC_APP_CLIENT_ID`). On iOS, all server traffic goes through native code (URLSession) so a per-app
VPN carries it. Copy a build into the projects with `bun run sync:ios` / `bun run sync:android`.
To preset the server or disable features, build with `OPENCODE_RC_CONFIG=/path/to/config.json bun run build`
(schema: `config/schema.ts`; see `docs/ios-app.md`).
```

  Also change "`ui/dist/` ... consumed by the UI image (`ui/web/`), the iOS project and the Android project" only if it mentions `cap sync` (it does not today; leave it).
- `README.md`: in the deployment/auth section, document `OIDC_APP_CLIENT_ID` and the IdP setup: a public client, PKCE (S256) required, redirect URI `com.opencode.rc:/auth/callback`, scopes `openid email profile`; and that `APP_LOGIN_PROMPT` now applies to app sign-ins through `/auth/app-config`.
- `docs/ios-app.md`, `ui/ios/README.md`: replace `npx cap sync ios` with `bun run sync:ios`; remove mentions of Capacitor and `capacitor-swift-pm`; describe the sign-in (Safari view, IdP must be reachable from Safari: on corporate devices, in the VPN's Safari Domains) and that API traffic uses URLSession.
- `ui/android/README.md`: `npx cap sync android` → `bun run sync:android`; remove Capacitor mentions.
- Spec: `Status: Implemented`.

Run: `git grep -n "cap sync\|Capacitor\|capacitor" -- ':!docs/superpowers' ':!**/bun.lock'` → prints nothing (or only the new origin explanation if worded with "Capacitor"; reword it).
Run: `git diff main --stat` and `git diff main | grep -nE "jsgr|rophyinc|192\.168|\.local/"` → nothing.

- [ ] **Step 2: Full verification**

1. `make unit-test` → exit 0.
2. Node 22: `cd api && npx -y node@22 node_modules/vitest/vitest.mjs run` and the same in `ui/` → all pass.
3. `helm unittest charts/opencode-rc` → all pass.
4. e2e on the kind cluster named in `LOCAL.md` (explicit `KUBE_CONTEXT` and a dedicated `NAMESPACE`): `./e2e/run.sh` → all pass, including "app sign-in".
5. Mac: `xcodebuild test` (Task 7 Step 4 command) → all pass.
6. `cd ui/android && ./gradlew test assembleDebug` → BUILD SUCCESSFUL.
7. Manual, iOS Simulator and Android emulator, against a test deployment with an app client: sign in (Safari view / Custom Tab shows only the IdP, returns to the app), session list loads, a session's live updates arrive (SSE), the terminal works (WebSocket), an upload works, an external link in a message opens the system browser, a long press on a link shows no preview (iOS). Record the results in the final report.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: native app shells, app sign-in and iOS native networking"
```
