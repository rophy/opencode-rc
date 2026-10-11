# opencode 2.0 Support, Step 5: The CLI's 2.x Mode

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a machine with opencode 2.x, `opencode-rc` starts a private opencode server
(`opencode serve --stdio`) with a random password, forwards tunnelled requests to it with that
password as Basic auth, and refuses a gateway too old to know opencode versions. 1.x machines are
unchanged.

**Architecture:** `startServer` returns a `LocalServer` `{ url, authorization?, close() }`: the
1.x path wraps the SDK's `createOpencodeServer` (no authorization); the 2.x path spawns
`opencode serve --stdio --hostname 127.0.0.1 --port 0` with `OPENCODE_PASSWORD`, reads the
`{"url": …}` line from stdout and stops the server by closing stdin. The tunnel forwards to
`local.url` and, when `local.authorization` is set, replaces any incoming `Authorization` header
with it and removes an `auth_token` query parameter (opencode 2.x prefers it over the header).
The gateway's tunnel protocol goes to 2 (it knows opencode versions since step 2); a 2.x CLI
requires it.

**Tech Stack:** Node + TypeScript (CLI, npm, vitest 4), Go (gateway).

**Spec:** `docs/superpowers/specs/2026-10-11-opencode-v2-support-design.md` ("CLI").

**Facts from opencode 2.0.26's source (vendor/opencode-v2/packages/cli/src):**
- `serve` flags: `--hostname`, `--port` (integer; `0` = any free port), `--stdio` (boolean),
  `--service`, `--cors` (`commands/commands.ts`). In `stdio` mode the server reads no service
  config, starts no remote tunnel, prints `JSON.stringify({ url })` once listening, and shuts
  down when stdin ends or closes (`server-process.ts`).
- The password comes from `OPENCODE_PASSWORD`, falling back to `OPENCODE_SERVER_PASSWORD`
  (`env.ts`); in stdio mode both are deleted from the server's environment after reading.
  Without either, a random password is used and never printed.
- Auth (`packages/server/src/middleware/authorization.ts`, `auth.ts`): username `opencode`;
  an `auth_token` query parameter is checked before the `Authorization: Basic …` header.
  PTY connections use a one-time `ticket` query parameter instead.

## Global Constraints

- Work in the worktree `.claude/worktrees/staging+v2` on branch `staging/v2`. Never push; never merge.
- 1.x machines: behaviour unchanged (same `createOpencodeServer` call, no authorization added, no protocol requirement change).
- 2.x launch command (verbatim args): `opencode serve --stdio --hostname 127.0.0.1 --port 0`, env `OPENCODE_PASSWORD=<random>` (32 random bytes, base64url) and `OPENCODE_SERVER_PASSWORD` removed from the child env.
- Forwarded 2.x requests: `Authorization: Basic base64("opencode:" + password)`, replacing any incoming Authorization header regardless of case; `auth_token` removed from the query.
- Protocol: gateway `TunnelProtocol` 1 → 2; gateway `MinCLIProtocol` stays 1; CLI `PROTOCOL` stays 1; a CLI in 2.x mode requires gateway protocol ≥ 2 (fatal, message tells the user the server is too old for opencode 2.x).
- Package managers: npm in `cli/`. CLI tests on Node 22: `npx -y node@22 node_modules/vitest/vitest.mjs run` in `cli/`; `npm run build`.
- Commit messages: `<type>: <short description>`; no attribution lines, no mention of Claude. GPG signing is automatic; never disable it.
- No version bumps. Committed text must not name `.local/`, `LOCAL.md`, private hostnames or IPs.

---

### Task 1: The 2.x local server launcher

**Files:**
- Modify: `cli/src/server.ts`
- Create: `cli/test/fixtures/fake-opencode-v2.mjs`, `cli/test/server.test.ts`

**Interfaces:**
- Produces:

```ts
export interface LocalServer {
  /** Base URL of the local opencode server, e.g. http://127.0.0.1:41234 */
  url: string;
  /** Authorization header value to send on every forwarded request (2.x only). */
  authorization?: string;
  close(): void;
}
export function startServer(major: 1 | 2, opts?: StartV2Options): Promise<LocalServer>;
export interface StartV2Options {
  /** Command to run (default "opencode"); tests pass a fake. */
  command?: string;
  /** Arguments before "serve" (tests: the fixture path when command is "node"). */
  prefixArgs?: string[];
  /** Milliseconds to wait for the {"url"} line (default 60000). */
  timeoutMs?: number;
  /** Called if the server exits on its own after it started. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}
```

- [ ] **Step 1: Fake server fixture** `cli/test/fixtures/fake-opencode-v2.mjs`: a Node script
  that checks its args are exactly `serve --stdio --hostname 127.0.0.1 --port 0` (else prints an
  error to stderr and exits 2); starts an `http` server on 127.0.0.1 port 0 that answers `200`
  with the JSON `{"ok":true}` only when `Authorization` equals
  `"Basic " + base64("opencode:" + <password read from OPENCODE_PASSWORD at startup>)` and the
  query has no `auth_token`, otherwise `401`; also answers `GET /env` with
  `{"serverPassword": process.env.OPENCODE_SERVER_PASSWORD ?? null}` captured at startup (auth
  required); prints `JSON.stringify({ url })` on stdout; exits when stdin ends. Env
  `FAKE_MODE=silent` makes it print nothing (for the timeout test); `FAKE_MODE=crash` makes it
  print `boom` to stderr and exit 1 before printing the URL; `FAKE_MODE=exit-later` exits 0
  500 ms after printing the URL.
- [ ] **Step 2: Failing tests** `cli/test/server.test.ts` (use `command: process.execPath`,
  `prefixArgs: [fixturePath]`):
  - resolves with an `http://127.0.0.1:<port>` url and an `authorization` that the fake accepts
    (`fetch(url, { headers: { authorization } })` → 200; without it → 401);
  - the child did not inherit `OPENCODE_SERVER_PASSWORD` (set it in the test's env first; `/env` reports `null`);
  - `close()` ends stdin and the child exits (poll the url until the connection fails, max 5 s);
  - `FAKE_MODE=crash` → rejects with an error that includes `boom`;
  - `FAKE_MODE=silent`, `timeoutMs: 300` → rejects with a timeout error, and the child is killed;
  - `FAKE_MODE=exit-later` → `onExit` is called with code 0.
  Run: `cd cli && npx -y node@22 node_modules/vitest/vitest.mjs run test/server.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `cli/src/server.ts`. Keep the 1.x branch as today (wrapping the
  SDK result as `{ url, close }`). For 2.x: `spawn(command, [...prefixArgs, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], { stdio: ["pipe", "pipe", "pipe"], env: <process.env without OPENCODE_SERVER_PASSWORD, plus OPENCODE_PASSWORD=password>, shell: process.platform === "win32" && command === "opencode" })`
  (the shell finds npm's `opencode.cmd` on Windows, as `opencode-version.ts` does). Read stdout
  line by line; the first line that parses as JSON with a string `url` resolves; other stdout
  lines and all stderr are forwarded to the CLI's stderr (prefix-free). Keep the last ~20 stderr
  lines for error messages. Exit before the URL → reject with the exit code and the stderr tail.
  Timeout → kill the child (SIGTERM, then SIGKILL after 3 s) and reject. `close()` → `child.stdin.end()`,
  then SIGTERM if it hasn't exited after 5 s. After resolving, a child exit calls `onExit`.
  `authorization = "Basic " + Buffer.from("opencode:" + password).toString("base64")`.
  Comment the non-obvious choices (why `--port 0`, why stdio, why the password env).
- [ ] **Step 4:** Run the CLI tests and build. Commit — `feat(cli): start a private opencode 2.x server`

---

### Task 2: Forward to the local server with its credentials

**Files:**
- Modify: `cli/src/tunnel.ts`
- Test: `cli/test/tunnel.test.ts`

**Interfaces:**
- Consumes: `LocalServer` (Task 1) — only `url` and `authorization`.
- Produces: `startTunnel(config, idToken, sessionID, local: { url: string; authorization?: string }, directory, opencodeVersion)` and the same change in `startTunnelWithReconnect` and `proxyToLocal` (the `localUrl: string` parameter becomes `local`). Update every call site, including all tests.

- [ ] **Step 1: Failing tests** in `cli/test/tunnel.test.ts` (follow the existing
  `proxyToLocal` tests, which run a local HTTP server):
  - with `local.authorization = "Basic abc"`, an HTTP request whose headers contain
    `authorization: Bearer user-token` (and a second test with `Authorization` capitalized)
    reaches the local server with exactly `authorization: Basic abc` (one header);
  - a request to `/api/session?auth_token=xyz&location=a` reaches the local server as
    `/api/session?location=a`;
  - a WebSocket upgrade gets the same header replacement and query stripping (follow the
    existing upgrade test);
  - without `local.authorization`, headers and query pass through unchanged (1.x).
- [ ] **Step 2: Implement**: one helper used by both `doProxyToLocal` and
  `proxyWebSocketToLocal`: build the target URL from `req.path` and `local.url`; if
  `local.authorization` is set, delete `auth_token` from `target.searchParams`, remove every header
  whose lower-cased name is `authorization`, and set `authorization` to `local.authorization`.
  Comment why (the browser's bearer token is for our API, not opencode; `auth_token` would
  override the header).
- [ ] **Step 3:** Run the CLI tests (all pass, counts reported) and build. Commit —
  `feat(cli): send the local opencode password on forwarded requests`

---

### Task 3: Turn on 2.x mode, gateway protocol 2

**Files:**
- Modify: `cli/src/index.ts`, `cli/src/protocol.ts` (and wherever the pre-flight checks the gateway protocol, `cli/src/tunnel.ts`), `gateway/protocol.go`, `docs/api-versioning.md`, `README.md` (CLI usage: 2.x supported), `AGENTS.md` only if it describes the CLI's launch
- Test: `cli/test/tunnel.test.ts` (pre-flight), `gateway/protocol_test.go`

**Interfaces:**
- Consumes: `startServer(major)` (Task 1), `startTunnel(..., local, ...)` (Task 2).

- [ ] **Step 1: Failing tests**:
  - Gateway: `TunnelProtocol` is 2 (the existing protocol tests show how the header is checked; update expectations).
  - CLI pre-flight: `startTunnel` with `opencodeVersion` `2.0.26` against a pre-flight response whose `OpenCode-RC-Protocol` header is `1` rejects with a `ProtocolError` whose message says the server is too old for opencode 2.x and to ask the administrator to upgrade; with header `2` it proceeds; with `opencodeVersion` `1.18.29` and header `1` it proceeds (unchanged 1.x behaviour).
- [ ] **Step 2: Implement**:
  - `gateway/protocol.go`: `TunnelProtocol = 2`, comment: 2 = the gateway checks the reported opencode version (`opencodeVersion`, 422 `opencode_unsupported`).
  - `cli/src/protocol.ts`: add `MIN_GATEWAY_PROTOCOL_V2 = 2` with a comment (a 2.x CLI relies on the gateway and API knowing opencode versions; an older server would apply 1.x guards to a 2.x machine). In the pre-flight, require it when the opencode major is 2.
  - `cli/src/index.ts`: replace the 2.x exit with 2.x mode: `const server = await startServer(major, { onExit: … })` where `onExit` prints that opencode stopped and exits 1 (closing the tunnel). Keep the error for majors other than 1 and 2 and the unknown-version warning path (which runs as 1.x). Pass `server` (as `local`) to the tunnel; `server.close()` on shutdown as today.
  - `docs/api-versioning.md`: one line for protocol 2 in the CLI ↔ gateway row/section.
  - `README.md`: the CLI section says opencode 1.x and 2.x (within the server's supported range) are supported; remove the "needs a CLI with 2.x support" caveat added in step 4 or reword it to "requires this version of the CLI or later" without a version number.
- [ ] **Step 3:** `cd cli && npm run build && npx -y node@22 node_modules/vitest/vitest.mjs run`;
  `cd ../gateway && go vet ./... && go test ./...`. Commit — `feat: run opencode 2.x from the CLI`

---

## After the tasks (controller)

- Local check with the real opencode 2.0.26 binary: install `@opencode/cli@2.0.26` into a scratch
  directory, put its bin first on PATH, and run the built CLI's `startServer(2)` (a small Node
  script importing `cli/dist/server.js`): `GET <url>/api/info` with the returned authorization → 200, without → 401;
  `close()` stops it. Also run `opencode-rc` itself against a gateway if feasible, else note it.
- e2e on kind for 1.x (unchanged): `KUBE_CONTEXT=kind-gen1 NAMESPACE=opencode-rc-e2e-v2 ./e2e/run.sh`.
- 2.x e2e is step 6.
