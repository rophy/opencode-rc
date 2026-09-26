# Protocol Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clients too old for their server (and servers too old for their client) are blocked with a clear message instead of failing confusingly.

**Architecture:** An `OpenCode-RC-Protocol: <int>` header on requests and responses. The API checks it on `/api/*`, `/gateway/*`, `POST /auth/token` and `POST /auth/refresh`. The gateway checks it on `/tunnel`. The UI and the CLI check the servers' response header and turn both failure directions into a message. Every protocol and every minimum starts at 1, and a missing header counts as 0.

**Tech Stack:** Hono/Bun API (vitest), Go gateway (`go test`), SolidJS UI (vitest, @solidjs/testing-library), Node CLI (vitest, npm), e2e (vitest + Playwright on kind).

**Spec:** `docs/superpowers/specs/2026-09-26-protocol-versioning-design.md`

## Global Constraints

- Header name: `OpenCode-RC-Protocol`. Value: a non-negative decimal integer. A missing or non-integer value reads as `0`.
- Constants: API `PROTOCOL = 1`, `MIN_CLIENT_PROTOCOL = 1`; gateway `TunnelProtocol = 1`, `MinCLIProtocol = 1`; UI `PROTOCOL = 1`, `MIN_SERVER_PROTOCOL = 1`; CLI `PROTOCOL = 1`, `MIN_GATEWAY_PROTOCOL = 1`.
- Too-old client JSON (API and gateway, status `426`): `{"error":"client_outdated","client":<n>,"minimum":<min>,"server":<protocol>}`.
- Gateway, CLI sent no header: `403`, `text/plain`, body exactly `opencode-rc CLI is too old for this server. Update it: npm i -g opencode-rc@latest`.
- CLI messages: too old: `opencode-rc CLI is too old for this server. Update it: npm i -g opencode-rc@latest`. Gateway too old: `The gateway at <url> is older than this CLI supports. Ask your administrator to upgrade it.` Both are fatal and never retried.
- UI screen texts:
  - client outdated, native app: `This version of OpenCode RC is no longer supported by your server. Please update the app.`
  - client outdated, web: `A new version of OpenCode RC is available.` plus a `Reload` button
  - server outdated: `Your OpenCode RC server is older than this app supports. Ask your administrator to upgrade it.`
- Unchecked paths: `/auth/start`, `/auth/callback`, `/auth/logout`, `/proxy/*`, `/healthz`.
- Package managers: `api/` and `ui/` use bun (tests: `npx vitest run`); `cli/` uses npm (tests: `npx vitest run`). Never mix them.
- Commits: `<type>: <description>`, no attribution lines, never mention Claude. Never write private hostnames into files.
- Do not change release versions (package.json `version`, `gateway/VERSION`, `Chart.yaml`).

---

### Task 1: API protocol header and client check

**Files:**
- Create: `api/src/protocol.ts`, `api/src/protocol.test.ts`
- Modify: `api/src/index.ts`, `api/src/auth.ts` (token and refresh routes), `api/src/origins.ts` (CORS), `api/src/auth.test.ts`, `api/src/origins.test.ts`

**Interfaces:**
- Produces: `PROTOCOL_HEADER = "OpenCode-RC-Protocol"`, `PROTOCOL = 1`, `MIN_CLIENT_PROTOCOL = 1`, `readProtocol(value: string | null | undefined): number`, `protocolHeader(): MiddlewareHandler` (sets the response header on every response), `requireClientProtocol(): MiddlewareHandler` (426 when too old).

- [ ] **Step 1: Write the failing tests** — `api/src/protocol.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  MIN_CLIENT_PROTOCOL, PROTOCOL, PROTOCOL_HEADER, protocolHeader, readProtocol, requireClientProtocol,
} from "./protocol.js";

function app() {
  const a = new Hono();
  a.use("*", protocolHeader());
  a.use("/checked/*", requireClientProtocol());
  a.get("/checked/x", (c) => c.json({ ok: true }));
  a.get("/open", (c) => c.json({ ok: true }));
  return a;
}

describe("readProtocol", () => {
  it("parses non-negative integers and treats anything else as 0", () => {
    expect(readProtocol("3")).toBe(3);
    for (const v of [undefined, null, "", "abc", "-1", "1.5", "2x"]) expect(readProtocol(v)).toBe(0);
  });
});

describe("protocol middleware", () => {
  it("starts at protocol 1", () => {
    expect(PROTOCOL).toBe(1);
    expect(MIN_CLIENT_PROTOCOL).toBe(1);
    expect(PROTOCOL_HEADER).toBe("OpenCode-RC-Protocol");
  });

  it("rejects a client without the header on checked paths", async () => {
    const res = await app().request("/checked/x");
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({ error: "client_outdated", client: 0, minimum: 1, server: 1 });
    expect(res.headers.get(PROTOCOL_HEADER)).toBe("1");
  });

  it("accepts a current client", async () => {
    const res = await app().request("/checked/x", { headers: { [PROTOCOL_HEADER]: "1" } });
    expect(res.status).toBe(200);
  });

  it("leaves unchecked paths alone and still sends the header", async () => {
    const res = await app().request("/open");
    expect(res.status).toBe(200);
    expect(res.headers.get(PROTOCOL_HEADER)).toBe("1");
  });
});
```

Also add to `api/src/origins.test.ts`, in `describe("corsMiddleware")`:

```ts
  it("exposes the protocol header to browser code", async () => {
    const res = await app.request("/x", { headers: { origin: "https://localhost" } });
    expect(res.headers.get("access-control-expose-headers")).toContain("OpenCode-RC-Protocol");
  });
```

(The existing `app` in that describe block mounts `corsMiddleware` on `/x`; reuse it.)

In `api/src/auth.test.ts`, the app under test mounts `authRoutes` directly. Add these tests to `describe("/auth/token")`:

```ts
  it("rejects a client without the protocol header", async () => {
    const res = await app.request("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x", code_verifier: "y" }),
    });
    expect(res.status).toBe(426);
  });
```

And to `describe("/auth/refresh and /auth/logout")`:

```ts
  it("rejects refresh without the protocol header but always allows logout", async () => {
    const plain = (path: string) => app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "nope" }),
    });
    expect((await plain("/auth/refresh")).status).toBe(426);
    expect((await plain("/auth/logout")).status).not.toBe(426);
  });
```

Existing `/auth/token` and `/auth/refresh` tests go through the file's `post(path, body)` helper. Add `[PROTOCOL_HEADER]: "1"` (import it from `./protocol.js`) to that helper's headers so they keep passing.

- [ ] **Step 2: Run and confirm failure**

Run: `cd api && npx vitest run src/protocol.test.ts src/origins.test.ts src/auth.test.ts`
Expected: FAIL (`./protocol.js` missing, header not exposed, token/refresh accepted without the header).

- [ ] **Step 3: Implement** — `api/src/protocol.ts`:

```ts
import type { MiddlewareHandler } from "hono";

// Client/server compatibility, independent of release versions (docs/api-versioning.md).
// Bump PROTOCOL for changes old clients cannot handle; raise MIN_CLIENT_PROTOCOL when
// those clients are no longer supported.
export const PROTOCOL_HEADER = "OpenCode-RC-Protocol";
export const PROTOCOL = 1;
export const MIN_CLIENT_PROTOCOL = 1;

export function readProtocol(value: string | null | undefined): number {
  return value && /^\d+$/.test(value) ? Number(value) : 0;
}

export function protocolHeader(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.res.headers.set(PROTOCOL_HEADER, String(PROTOCOL));
  };
}

export function requireClientProtocol(): MiddlewareHandler {
  return async (c, next) => {
    const client = readProtocol(c.req.header(PROTOCOL_HEADER));
    if (client < MIN_CLIENT_PROTOCOL) {
      return c.json(
        { error: "client_outdated", client, minimum: MIN_CLIENT_PROTOCOL, server: PROTOCOL },
        426,
      );
    }
    await next();
  };
}
```

`api/src/origins.ts`, in `corsMiddleware`'s `cors({...})` add:

```ts
    // Lets browser code read the server's protocol (docs/api-versioning.md).
    exposeHeaders: ["OpenCode-RC-Protocol"],
```

`api/src/auth.ts`: import `requireClientProtocol` from `./protocol.js` and add it as the first handler argument of the two routes:

```ts
  app.post("/auth/token", requireClientProtocol(), async (c) => {
```
```ts
  app.post("/auth/refresh", requireClientProtocol(), async (c) => {
```

`api/src/index.ts`:
- import `{ PROTOCOL, protocolHeader, requireClientProtocol }` from `./protocol.js`;
- right after `app.use("*", corsMiddleware(isAllowedOrigin));` add:
  ```ts
  app.use("*", protocolHeader());
  // Every UI session starts with these calls, so an outdated client is stopped here.
  app.use("/api/*", requireClientProtocol());
  app.use("/gateway/*", requireClientProtocol());
  ```
- in `/healthz` return `{ status: ok ? "ok" : "degraded", version, protocol: PROTOCOL }`.

- [ ] **Step 4: Run the API suite**

Run: `cd api && npx vitest run && npx tsc --noEmit -p .`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add api/src
git commit -m "feat(api): protocol header and outdated-client check"
```

---

### Task 2: Gateway protocol header and tunnel check

**Files:**
- Create: `gateway/protocol.go`, `gateway/protocol_test.go`
- Modify: `gateway/tunnel.go` (start of `TunnelHandler`), `gateway/routes_gateway.go` (`/healthz`), `gateway/main.go` (`setupGateway` return), existing tests that call `/tunnel` without the header

**Interfaces:**
- Produces: `const ProtocolHeader = "OpenCode-RC-Protocol"`, `const TunnelProtocol = 1`, `const MinCLIProtocol = 1`, `func readProtocol(v string) int`, `func withProtocolHeader(h http.Handler) http.Handler`, `func checkCLIProtocol(w http.ResponseWriter, r *http.Request) bool` (writes the rejection and returns false when the CLI is too old).

- [ ] **Step 1: Write the failing tests** — `gateway/protocol_test.go`:

```go
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReadProtocol(t *testing.T) {
	cases := map[string]int{"3": 3, "": 0, "abc": 0, "-1": 0, "1.5": 0, "2x": 0}
	for in, want := range cases {
		if got := readProtocol(in); got != want {
			t.Errorf("readProtocol(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestCheckCLIProtocolWithoutHeader(t *testing.T) {
	w := httptest.NewRecorder()
	if checkCLIProtocol(w, httptest.NewRequest("GET", "/tunnel", nil)) {
		t.Fatal("expected rejection")
	}
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
	want := "opencode-rc CLI is too old for this server. Update it: npm i -g opencode-rc@latest"
	if strings.TrimSpace(w.Body.String()) != want {
		t.Fatalf("body = %q", w.Body.String())
	}
}

func TestCheckCLIProtocolTooLow(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/tunnel", nil)
	r.Header.Set(ProtocolHeader, "0")
	if checkCLIProtocol(w, r) {
		t.Fatal("expected rejection")
	}
	if w.Code != http.StatusUpgradeRequired {
		t.Fatalf("status = %d, want 426", w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "client_outdated" || body["client"] != float64(0) || body["minimum"] != float64(1) || body["server"] != float64(1) {
		t.Fatalf("body = %v", body)
	}
}

func TestCheckCLIProtocolCurrent(t *testing.T) {
	r := httptest.NewRequest("GET", "/tunnel", nil)
	r.Header.Set(ProtocolHeader, "1")
	if !checkCLIProtocol(httptest.NewRecorder(), r) {
		t.Fatal("expected acceptance")
	}
}

func TestWithProtocolHeader(t *testing.T) {
	h := withProtocolHeader(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/x", nil))
	if w.Header().Get(ProtocolHeader) != "1" {
		t.Fatalf("header = %q", w.Header().Get(ProtocolHeader))
	}
}

func TestTunnelChecksProtocolBeforeAuth(t *testing.T) {
	h := TunnelHandler(nil, nil, nil, "pod:9090")
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest("GET", "/tunnel?sessionId=s", nil))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (protocol) before 401 (auth)", w.Code)
	}
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd gateway && go test ./... 2>&1 | tail -5`
Expected: FAIL (undefined: readProtocol, checkCLIProtocol, …).

- [ ] **Step 3: Implement** — `gateway/protocol.go`:

```go
package main

import (
	"net/http"
	"regexp"
	"strconv"
)

// Client/server compatibility for the CLI tunnel, independent of release versions
// (docs/api-versioning.md). Bump TunnelProtocol for changes old CLIs cannot handle;
// raise MinCLIProtocol when those CLIs are no longer supported.
const (
	ProtocolHeader = "OpenCode-RC-Protocol"
	TunnelProtocol = 1
	MinCLIProtocol = 1
)

const cliTooOldMessage = "opencode-rc CLI is too old for this server. Update it: npm i -g opencode-rc@latest"

var protocolPattern = regexp.MustCompile(`^\d+$`)

func readProtocol(v string) int {
	if !protocolPattern.MatchString(v) {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0
	}
	return n
}

func withProtocolHeader(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(ProtocolHeader, strconv.Itoa(TunnelProtocol))
		h.ServeHTTP(w, r)
	})
}

// checkCLIProtocol rejects CLIs older than MinCLIProtocol. CLIs released before protocol
// versioning send no header and print the pre-flight body only for 401/403/5xx, so they
// get a plain-text 403.
func checkCLIProtocol(w http.ResponseWriter, r *http.Request) bool {
	raw := r.Header.Get(ProtocolHeader)
	client := readProtocol(raw)
	if client >= MinCLIProtocol {
		return true
	}
	if raw == "" {
		http.Error(w, cliTooOldMessage, http.StatusForbidden)
		return false
	}
	marshalJSON(w, http.StatusUpgradeRequired, map[string]any{
		"error": "client_outdated", "client": client, "minimum": MinCLIProtocol, "server": TunnelProtocol,
	})
	return false
}
```

(`marshalJSON` already exists in the package; it is used by `/healthz`.)

`gateway/tunnel.go`, first lines inside the handler func of `TunnelHandler`, before the Bearer check:

```go
		if !checkCLIProtocol(w, r) {
			return
		}
```

`gateway/routes_gateway.go`, `/healthz`: return `map[string]any{"status": status, "version": version, "protocol": TunnelProtocol}` (switch the map type from `map[string]string`).

`gateway/main.go`, in `setupGateway`: `return requestLogger(withProtocolHeader(mux)), nil`.

- [ ] **Step 4: Fix existing tests that call `/tunnel` without the header**

Run `cd gateway && go test ./... 2>&1 | grep -E "FAIL|---"`. Every existing test that hits `/tunnel` now gets 403. In those tests (look in `tunnel_test.go`, `routes_test.go`, `testhelper_test.go`), set `ProtocolHeader: "1"` on the request or the WebSocket dial headers (for `websocket.Dialer`, add it to the `http.Header` passed to `Dial`). Only add the header; do not change assertions. Any `/healthz` test comparing a `map[string]string` must accept the new `protocol` number.

- [ ] **Step 5: Run the gateway suite**

Run: `cd gateway && gofmt -l . && go vet ./... && go test ./...`
Expected: no gofmt output, vet clean, `ok`.

- [ ] **Step 6: Commit**

```bash
git add gateway
git commit -m "feat(gateway): protocol header and outdated-CLI check on /tunnel"
```

---

### Task 3: UI sends the protocol and shows outdated screens

**Files:**
- Create: `ui/src/protocol.ts`, `ui/src/protocol.test.ts`, `ui/src/protocol-screen.tsx`, `ui/src/protocol-screen.test.tsx`
- Modify: `ui/src/auth.ts` (`authFetch`, `postJson`), `ui/src/config-screen.tsx` (healthz check), `ui/src/entry.tsx` (render the screen), affected tests (`ui/src/auth.test.ts`, `ui/src/api.test.ts`, `ui/src/config-screen*.test.tsx` if present)

**Interfaces:**
- Produces (`ui/src/protocol.ts`):
  ```ts
  export const PROTOCOL_HEADER = "OpenCode-RC-Protocol"
  export const PROTOCOL = 1
  export const MIN_SERVER_PROTOCOL = 1
  export type ProtocolState = "ok" | "client_outdated" | "server_outdated"
  export function readProtocol(value: string | null | undefined): number
  export function withProtocol(init?: RequestInit): RequestInit   // adds the request header
  export async function checkProtocol(res: Response): Promise<void> // updates the state
  export const protocolState: () => ProtocolState                 // Solid accessor
  export function resetProtocolState(): void                      // tests
  ```
- `ProtocolScreen: Component<{ state: "client_outdated" | "server_outdated" }>` in `ui/src/protocol-screen.tsx`.

- [ ] **Step 1: Write the failing tests** — `ui/src/protocol.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest"
import {
  MIN_SERVER_PROTOCOL, PROTOCOL, PROTOCOL_HEADER, checkProtocol, protocolState, readProtocol,
  resetProtocolState, withProtocol,
} from "./protocol"

const res = (status: number, headers: Record<string, string> = {}, body = "{}") =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } })

beforeEach(() => resetProtocolState())

describe("protocol", () => {
  it("starts at protocol 1", () => {
    expect(PROTOCOL).toBe(1)
    expect(MIN_SERVER_PROTOCOL).toBe(1)
  })

  it("reads integers and treats anything else as 0", () => {
    expect(readProtocol("2")).toBe(2)
    for (const v of [null, undefined, "", "x", "-1", "1.5"]) expect(readProtocol(v)).toBe(0)
  })

  it("adds the header without dropping others", () => {
    const h = new Headers(withProtocol({ headers: { a: "b" } }).headers)
    expect(h.get(PROTOCOL_HEADER)).toBe("1")
    expect(h.get("a")).toBe("b")
  })

  it("stays ok for a current server", async () => {
    await checkProtocol(res(200, { [PROTOCOL_HEADER]: "1" }))
    expect(protocolState()).toBe("ok")
  })

  it("flags an outdated client on 426 client_outdated", async () => {
    await checkProtocol(res(426, { [PROTOCOL_HEADER]: "2" }, JSON.stringify({ error: "client_outdated" })))
    expect(protocolState()).toBe("client_outdated")
  })

  it("flags an outdated server when the header is missing or too low", async () => {
    await checkProtocol(res(200))
    expect(protocolState()).toBe("server_outdated")
    resetProtocolState()
    await checkProtocol(res(200, { [PROTOCOL_HEADER]: "0" }))
    expect(protocolState()).toBe("server_outdated")
  })

  it("does not consume the caller's body", async () => {
    const r = res(426, { [PROTOCOL_HEADER]: "2" }, JSON.stringify({ error: "client_outdated" }))
    await checkProtocol(r)
    expect(await r.json()).toEqual({ error: "client_outdated" })
  })
})
```

`ui/src/protocol-screen.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@solidjs/testing-library"

const native = vi.hoisted(() => ({ value: false }))
vi.mock("@capacitor/core", async (orig) => ({
  ...(await orig<typeof import("@capacitor/core")>()),
  Capacitor: { isNativePlatform: () => native.value },
}))

import { ProtocolScreen } from "./protocol-screen"

afterEach(() => { cleanup(); native.value = false })

describe("ProtocolScreen", () => {
  it("asks web users to reload", async () => {
    const reload = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as unknown as Location)
    render(() => <ProtocolScreen state="client_outdated" />)
    expect(screen.getByText("A new version of OpenCode RC is available.")).toBeTruthy()
    await fireEvent.click(screen.getByText("Reload"))
    expect(reload).toHaveBeenCalled()
  })

  it("asks app users to update the app", () => {
    native.value = true
    render(() => <ProtocolScreen state="client_outdated" />)
    expect(screen.getByText("This version of OpenCode RC is no longer supported by your server. Please update the app.")).toBeTruthy()
    expect(screen.queryByText("Reload")).toBeNull()
  })

  it("explains an outdated server", () => {
    render(() => <ProtocolScreen state="server_outdated" />)
    expect(screen.getByText("Your OpenCode RC server is older than this app supports. Ask your administrator to upgrade it.")).toBeTruthy()
  })
})
```

Add to `ui/src/auth.test.ts` (it already mocks `fetch` with `vi.spyOn(globalThis, "fetch")`):

```ts
describe("protocol header", () => {
  it("authFetch and the token calls send the protocol header", async () => {
    localStorage.setItem(REFRESH_KEY, "refresh-0")
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json(tokens(1), 200),
    )
    await authFetch("/api/me")
    for (const [, init] of spy.mock.calls as [string, RequestInit][]) {
      expect(new Headers(init.headers).get("OpenCode-RC-Protocol")).toBe("1")
    }
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2) // refresh + /api/me
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd ui && npx vitest run src/protocol.test.ts src/protocol-screen.test.tsx src/auth.test.ts`
Expected: FAIL (modules missing, header not sent).

- [ ] **Step 3: Implement** — `ui/src/protocol.ts`:

```ts
import { createSignal } from "solid-js"

// Client/server compatibility with the API, independent of release versions
// (docs/api-versioning.md). Raise MIN_SERVER_PROTOCOL when the UI relies on newer
// server behaviour; bump PROTOCOL when the server needs to tell this UI apart.
export const PROTOCOL_HEADER = "OpenCode-RC-Protocol"
export const PROTOCOL = 1
export const MIN_SERVER_PROTOCOL = 1

export type ProtocolState = "ok" | "client_outdated" | "server_outdated"

const [state, setState] = createSignal<ProtocolState>("ok")
export const protocolState = state

export function resetProtocolState(): void {
  setState("ok")
}

export function readProtocol(value: string | null | undefined): number {
  return value && /^\d+$/.test(value) ? Number(value) : 0
}

export function withProtocol(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers)
  headers.set(PROTOCOL_HEADER, String(PROTOCOL))
  return { ...init, headers }
}

// Inspects a response from the API: a 426 client_outdated means this UI is too old;
// a missing or too-low server header means the server is too old.
export async function checkProtocol(res: Response): Promise<void> {
  if (res.status === 426) {
    try {
      const body = (await res.clone().json()) as { error?: string }
      if (body.error === "client_outdated") {
        setState("client_outdated")
        return
      }
    } catch {}
  }
  if (readProtocol(res.headers.get(PROTOCOL_HEADER)) < MIN_SERVER_PROTOCOL) setState("server_outdated")
}
```

`ui/src/protocol-screen.tsx` (follow the existing screens' layout classes, e.g. `login-screen.tsx`):

```tsx
import { type Component, Show } from "solid-js"
import { Capacitor } from "@capacitor/core"

export const ProtocolScreen: Component<{ state: "client_outdated" | "server_outdated" }> = (props) => {
  const native = Capacitor.isNativePlatform()
  const message = () =>
    props.state === "server_outdated"
      ? "Your OpenCode RC server is older than this app supports. Ask your administrator to upgrade it."
      : native
        ? "This version of OpenCode RC is no longer supported by your server. Please update the app."
        : "A new version of OpenCode RC is available."
  return (
    <div class="flex flex-1 flex-col items-center bg-v2-background-bg-base">
      <div class="w-full max-w-lg px-6 pt-16 pb-8 text-center">
        <h1 class="text-[18px] font-semibold text-v2-text-text-base leading-tight mb-4">opencode-rc</h1>
        <p class="text-13-regular text-v2-text-text-muted mb-6">{message()}</p>
        <Show when={props.state === "client_outdated" && !native}>
          <button
            onClick={() => window.location.reload()}
            class="inline-flex items-center rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-4 py-2 text-[13px] font-medium text-v2-text-text-base cursor-pointer"
          >
            Reload
          </button>
        </Show>
      </div>
    </div>
  )
}
```

`ui/src/auth.ts`:
- import `{ checkProtocol, withProtocol }` from `./protocol`;
- `postJson`: build the request with `withProtocol({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })`, then `await checkProtocol(res)` before returning `res`. It must still return the `Response`; make `postJson` `async`.
- `authFetch`: in `send`, pass `withProtocol({ ...init, headers })` to `fetch`, and call `await checkProtocol(res)` on each response before returning it.

`ui/src/config-screen.tsx`, in `handleSave` after the `/healthz` fetch succeeds:

```tsx
      const health = (await res.json().catch(() => ({}))) as { protocol?: unknown }
      if (readProtocol(String(health.protocol ?? "")) < MIN_SERVER_PROTOCOL) {
        setError("This server is older than this app supports. Ask your administrator to upgrade it.")
        setTesting(false)
        return
      }
```

(import `{ MIN_SERVER_PROTOCOL, readProtocol }` from `./protocol`; the `fetch` result must be kept in a variable `res` that is in scope here; restructure the `try` minimally.)

`ui/src/entry.tsx`, in `App`: import `{ protocolState }` and `{ ProtocolScreen }`, and add as the **first** `<Match>` in the `<Switch>`:

```tsx
      <Match when={protocolState() !== "ok"}>
        <ProtocolScreen state={protocolState() as "client_outdated" | "server_outdated"} />
      </Match>
```

- [ ] **Step 4: Update affected tests**

Tests that mock `fetch` with responses lacking the protocol header now put the state into `server_outdated`. That only matters where a test renders `App` or asserts on state; unit tests of `fetchMe`, `fetchSessions` and the login screen keep passing. Call `resetProtocolState()` in `beforeEach` of `ui/src/auth.test.ts`, `ui/src/api.test.ts` and `ui/src/auth-native.test.ts`, so state never leaks between tests. If the config-screen test file exists (`ls ui/src/config-screen*.test.tsx`), make its successful `/healthz` mock return `{"status":"ok","protocol":1}`, and add one test where `{"status":"ok"}` (no protocol) shows `This server is older than this app supports. Ask your administrator to upgrade it.`

- [ ] **Step 5: Run the UI suite**

Run: `cd ui && npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src
git commit -m "feat(ui): send the protocol version and show outdated client/server screens"
```

---

### Task 4: CLI sends the protocol and fails clearly on mismatch

**Files:**
- Create: `cli/src/protocol.ts`
- Modify: `cli/src/tunnel.ts` (pre-flight, WebSocket headers, both reconnect loops), `cli/test/tunnel.test.ts`

**Interfaces:**
- Produces (`cli/src/protocol.ts`): `PROTOCOL_HEADER = "OpenCode-RC-Protocol"`, `PROTOCOL = 1`, `MIN_GATEWAY_PROTOCOL = 1`, `readProtocol(value: string | null | undefined): number`, `class ProtocolError extends Error` (fatal; never retried).

- [ ] **Step 1: Write the failing tests** — add to `cli/test/tunnel.test.ts` (it already has `withHttpServer` and `makeConfig`):

```ts
describe("protocol versioning", () => {
  it("sends the protocol header on the pre-flight", async () => {
    let seen: string | undefined
    await withHttpServer(
      (req, res) => {
        seen = req.headers["opencode-rc-protocol"] as string | undefined
        res.writeHead(401, { "Content-Type": "text/plain", "OpenCode-RC-Protocol": "1" })
        res.end("no")
      },
      async (port) => {
        await expect(startTunnel(makeConfig(port), "t", "s1", "http://localhost:9999", "/tmp")).rejects.toThrow()
      }
    )
    expect(seen).toBe("1")
  })

  it("stops with an update message when the gateway says the CLI is outdated", async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(426, { "Content-Type": "application/json", "OpenCode-RC-Protocol": "2" })
        res.end(JSON.stringify({ error: "client_outdated", client: 1, minimum: 2, server: 2 }))
      },
      async (port) => {
        const p = startTunnel(makeConfig(port), "t", "s1", "http://localhost:9999", "/tmp")
        await expect(p).rejects.toBeInstanceOf(ProtocolError)
        await expect(p).rejects.toThrow("opencode-rc CLI is too old for this server. Update it: npm i -g opencode-rc@latest")
      }
    )
  })

  it("stops when the gateway is older than the CLI supports", async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(400, { "Content-Type": "text/plain" }) // an old gateway: no protocol header
        res.end("websocket required")
      },
      async (port) => {
        const p = startTunnel(makeConfig(port), "t", "s1", "http://localhost:9999", "/tmp")
        await expect(p).rejects.toBeInstanceOf(ProtocolError)
        await expect(p).rejects.toThrow(`The gateway at http://localhost:${port} is older than this CLI supports. Ask your administrator to upgrade it.`)
      }
    )
  })

  it("does not retry protocol errors", async () => {
    let calls = 0
    await withHttpServer(
      (_req, res) => {
        calls++
        res.writeHead(400, { "Content-Type": "text/plain" })
        res.end("old gateway")
      },
      async (port) => {
        await expect(
          startTunnelWithReconnect(makeConfig(port), "t", "s1", "http://localhost:9999", "/tmp")
        ).rejects.toBeInstanceOf(ProtocolError)
      }
    )
    expect(calls).toBe(1)
  })
})
```

Import `ProtocolError` from `../src/protocol.js` and `startTunnelWithReconnect` from `../src/tunnel.js` at the top of the test file if not already imported. Check what `makeConfig(port)` sets `gatewayUrl` to and match the message's URL to it exactly.

- [ ] **Step 2: Run and confirm failure**

Run: `cd cli && npx vitest run test/tunnel.test.ts`
Expected: FAIL (module missing, no header sent).

- [ ] **Step 3: Implement** — `cli/src/protocol.ts`:

```ts
// Compatibility with the gateway's tunnel, independent of release versions
// (docs/api-versioning.md). Raise MIN_GATEWAY_PROTOCOL when the CLI relies on newer
// gateway behaviour; bump PROTOCOL when the gateway needs to tell this CLI apart.
export const PROTOCOL_HEADER = "OpenCode-RC-Protocol";
export const PROTOCOL = 1;
export const MIN_GATEWAY_PROTOCOL = 1;

export function readProtocol(value: string | null | undefined): number {
  return value && /^\d+$/.test(value) ? Number(value) : 0;
}

/** A client/server version mismatch: fatal, never retried. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}
```

`cli/src/tunnel.ts`, in `startTunnel`:
- pre-flight `fetch` headers: `{ Authorization: \`Bearer ${idToken}\`, [PROTOCOL_HEADER]: String(PROTOCOL) }`;
- right after the pre-flight `fetch` returns, before the existing status handling:
  ```ts
    if (resp.status === 426) {
      const body = (await resp.clone().json().catch(() => ({}))) as { error?: string };
      if (body.error === "client_outdated") {
        throw new ProtocolError("opencode-rc CLI is too old for this server. Update it: npm i -g opencode-rc@latest");
      }
    }
    if (readProtocol(resp.headers.get(PROTOCOL_HEADER)) < MIN_GATEWAY_PROTOCOL) {
      throw new ProtocolError(
        `The gateway at ${baseUrl} is older than this CLI supports. Ask your administrator to upgrade it.`,
      );
    }
  ```
- the existing `catch (err: any)` around the pre-flight must rethrow `ProtocolError` unchanged (add `if (err instanceof ProtocolError) throw err;` as its first line);
- WebSocket headers: add `[PROTOCOL_HEADER]: String(PROTOCOL)`.

In `startTunnelWithReconnect`, in **both** `catch (err)` blocks (the initial-connect loop and `connectLoop`), add as the first line:

```ts
        if (err instanceof ProtocolError) throw err;
```

For `connectLoop`, which runs in the background, a thrown `ProtocolError` must end the process with the message. Instead of throwing there, print it and exit:

```ts
        if (err instanceof ProtocolError) {
          console.error(err.message);
          process.exit(1);
        }
```

`cli/src/index.ts` already prints errors from `main()` and exits 1, which covers the initial connect.

- [ ] **Step 4: Update existing tunnel tests**

Existing tests whose fake gateways answer the pre-flight (400/405/426) now fail with "gateway older than this CLI" unless the fake response carries `OpenCode-RC-Protocol: 1`. Add that header to every such fake server's pre-flight response. Do not change assertions otherwise. The existing 401, 403 and 502 pre-flight tests run their status check after the protocol check, so give their fake responses the header too, keeping their assertions unchanged.

- [ ] **Step 5: Run the CLI suite**

Run: `cd cli && npx vitest run && npx tsc --noEmit -p .`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add cli/src/protocol.ts cli/src/tunnel.ts cli/test/tunnel.test.ts
git commit -m "feat(cli): send the protocol version and stop clearly on a mismatch"
```

---

### Task 5: e2e coverage and documentation

**Files:**
- Modify: `e2e/e2e.test.ts`, `docs/api-versioning.md`, `docs/superpowers/specs/2026-09-26-protocol-versioning-design.md` (checked paths list)

**Interfaces:**
- Consumes: header name and behaviour from Tasks 1–4.

- [ ] **Step 1: Send the header from the e2e helpers**

In `e2e/e2e.test.ts` add near the top:

```ts
const PROTOCOL = { "OpenCode-RC-Protocol": "1" };
```

- `TokenSession.fetch`: `headers.set("OpenCode-RC-Protocol", "1");` next to the authorization header.
- `postJson`: `headers: { "content-type": "application/json", ...PROTOCOL }`.
- Every other direct `fetch` to `${API_URL}/api/…` or `${API_URL}/gateway/…` (find them with `grep -n 'fetch(`${API_URL}/\(api\|gateway\)' e2e/e2e.test.ts`, e.g. the unauthenticated 401 tests): add `headers: PROTOCOL`, merged with any headers already given. Those tests keep asserting 401.

- [ ] **Step 2: Add e2e tests** — a new `describe("protocol versioning")` block:

```ts
describe("protocol versioning", () => {
  it("API rejects a client without the protocol header", async () => {
    const res = await fetch(`${API_URL}/api/me`);
    expect(res.status).toBe(426);
    expect(await res.json()).toMatchObject({ error: "client_outdated", client: 0, minimum: 1 });
    expect(res.headers.get("OpenCode-RC-Protocol")).toBe("1");
  });

  it("API healthz reports its protocol", async () => {
    expect(await (await fetch(`${API_URL}/healthz`)).json()).toMatchObject({ protocol: 1 });
  });

  it("gateway tells an old CLI to update", async () => {
    const res = await fetch(`${GATEWAY_URL}/tunnel?sessionId=e2e-old-cli&directory=%2Ftmp`);
    expect(res.status).toBe(403);
    expect((await res.text()).trim()).toBe(
      "opencode-rc CLI is too old for this server. Update it: npm i -g opencode-rc@latest",
    );
  });
});
```

(`GATEWAY_URL` is already provided to the e2e tests; check the top of the file for the constant's name.)

- [ ] **Step 3: Rewrite `docs/api-versioning.md`**

Replace the whole file:

```markdown
# Protocol Versioning

Clients and servers exchange a small integer protocol version so that a client too old
for its server, or a server too old for its client, fails with a clear message.

## Boundaries

| Boundary | Server constant | Client constant |
|---|---|---|
| UI (web and apps) ↔ API | `api/src/protocol.ts`: `PROTOCOL`, `MIN_CLIENT_PROTOCOL` | `ui/src/protocol.ts`: `PROTOCOL`, `MIN_SERVER_PROTOCOL` |
| CLI ↔ gateway | `gateway/protocol.go`: `TunnelProtocol`, `MinCLIProtocol` | `cli/src/protocol.ts`: `PROTOCOL`, `MIN_GATEWAY_PROTOCOL` |

The API and gateway are deployed together by the chart, so they need no versioning
between them.

## Mechanism

- Requests and responses carry `OpenCode-RC-Protocol: <n>`. A missing or invalid value
  counts as 0. `/healthz` also reports `"protocol"`.
- The API checks the client on `/api/*`, `/gateway/*`, `POST /auth/token` and
  `POST /auth/refresh` and answers `426 {"error":"client_outdated", ...}` when it is too
  old. `/auth/start`, `/auth/callback`, `/auth/logout`, `/proxy/*` and `/healthz` are not
  checked.
- The gateway checks `/tunnel` before authentication: `426` JSON for a versioned but
  outdated CLI, and a plain-text `403` for CLIs that send no header (older CLIs print
  that body).
- The UI shows a full-screen message: update the app, reload the page, or ask the
  administrator to upgrade the server. The CLI prints the matching message and exits.

## When to change the numbers

- A server change that old clients cannot handle: bump the server's protocol. Raise its
  minimum client protocol when those clients are no longer supported.
- A client that relies on new server behaviour: raise the client's minimum server
  protocol.
- Release versions are independent of protocol numbers.
```

In the spec, change the API check list from `/api/*` to `/api/*` and `/gateway/*` (the UI's session list is served under `/gateway/sessions`) in the Decisions/API sections.

- [ ] **Step 4: Run everything**

Run: `make unit-test`, then the full e2e: `KUBE_CONTEXT=<a kind context> ./e2e/run.sh`.
Expected: unit tests green; e2e vitest and Playwright green, including the new tests.

- [ ] **Step 5: Commit**

```bash
git add e2e/e2e.test.ts docs/api-versioning.md docs/superpowers/specs/2026-09-26-protocol-versioning-design.md
git commit -m "test(e2e): protocol versioning; docs: describe the mechanism"
```
