# opencode 2.0 Support, Step 2: Report and Check the opencode Version

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every dev machine reports its opencode version. The gateway stores it, shows it in the
session list, and rejects versions it does not support (all 2.x for now). The CLI refuses to start
on opencode 2.x until step 5. The picker shows each machine's version.

**Architecture:** The CLI runs `opencode --version` before starting opencode and sends the
normalized version (`1.18.29`) as `opencodeVersion` on `/tunnel`. The gateway checks it against a
version policy loaded from `config/opencode-versions.json` (copied into the gateway image) and
stores it in the session record. The API passes the field through to the UI.

**Tech Stack:** Go (gateway), Node + vitest 4 (CLI, npm), Bun + Hono + vitest 5 (API), SolidJS +
vitest 5 (UI), Playwright/vitest e2e on kind.

**Spec:** `docs/superpowers/specs/2026-10-11-opencode-v2-support-design.md` (sections "CLI",
"Gateway", "Version policy within 2.x").

**Scope decisions for this step (controller):**
- Deployment narrowing (`opencodeV2.versions` in `config.json`, mounting the config into the
  gateway) is deferred to step 4, when there is a default 2.x range to narrow. Step 2 reads only
  the repo default, which supports no 2.x.
- Picker routing to `/v2/` is step 4. No protocol-number bump in this step (step 5).

## Global Constraints

- Work in the worktree `.claude/worktrees/staging+v2` on branch `staging/v2`. Never push; never merge.
- 1.x behaviour must not change, except that the CLI now runs `opencode --version` first.
- A missing `opencodeVersion` means 1.x: CLIs already in use keep working unchanged.
- Version strings on the wire are normalized `MAJOR.MINOR.PATCH` (digits only), e.g. `1.18.29`.
- Range semantics: `min ≤ version < max` (min inclusive, max exclusive).
- `config/opencode-versions.json` content for this step (verbatim): `{ "v2": null }`.
- CLI message on 2.x (verbatim start): `opencode 2.x needs a newer opencode-rc`.
- Gateway rejection: HTTP 422, JSON `{"error":"opencode_unsupported","message":"..."}`, sent before the WebSocket upgrade.
- Package managers: npm in `cli/`; bun in `api/`, `ui/`. Go tests with `go test ./...` in `gateway/` (needs Redis like the existing tests; follow how they run).
- Unit tests on Node 22 for api/ui: `npx -y node@22 node_modules/vitest/vitest.mjs run`. CLI: `npm test` (CI uses Node 22: `npx -y node@22 node_modules/vitest/vitest.mjs run` in `cli/`).
- Commit messages: `<type>: <short description>`; no attribution lines, no mention of Claude. GPG signing is automatic; never disable it.
- No version bumps. Committed text must not name `.local/`, `LOCAL.md`, private hostnames or IPs.

---

### Task 1: Gateway — version policy, check and store

**Files:**
- Create: `config/opencode-versions.json`
- Create: `gateway/versions.go`, `gateway/versions_test.go`
- Modify: `gateway/store.go` (`SessionMeta`), `gateway/registry.go` (`Register`), `gateway/tunnel.go` (`TunnelHandler`), `gateway/routes_gateway.go`, `gateway/config.go`, `gateway/main.go`
- Modify: every test call of `Register(` and `TunnelHandler(` (`gateway/*_test.go`)
- Modify: `gateway/Dockerfile` (copy the versions file into the image)
- Test: `gateway/versions_test.go`, `gateway/tunnel_test.go`, `gateway/registry_test.go`

**Interfaces:**
- Produces: session record JSON field `opencodeVersion` (string, omitted when empty), read by the API (Task 3). `/tunnel` query parameter `opencodeVersion`. 422 `opencode_unsupported` response, handled by the CLI (Task 2).

- [ ] **Step 1: Write the versions file**

`config/opencode-versions.json`:

```json
{ "v2": null }
```

- [ ] **Step 2: Write failing tests for the policy**

`gateway/versions_test.go`:

```go
package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseVersion(t *testing.T) {
	if v, ok := ParseVersion("1.18.29"); !ok || v != (Version{1, 18, 29}) {
		t.Fatalf("ParseVersion(1.18.29) = %v, %v", v, ok)
	}
	for _, bad := range []string{"", "1.18", "v1.18.29", "1.18.29-beta", "1.18.x", " 1.2.3"} {
		if _, ok := ParseVersion(bad); ok {
			t.Errorf("ParseVersion(%q) accepted", bad)
		}
	}
}

func TestVersionPolicyCheck(t *testing.T) {
	none := VersionPolicy{}
	ranged := VersionPolicy{V2: &VersionRange{Min: Version{2, 0, 20}, Max: Version{2, 0, 27}}}
	cases := []struct {
		policy  VersionPolicy
		version string
		ok      bool
	}{
		{none, "", true},         // older CLIs send nothing: 1.x
		{none, "1.18.29", true},  // any 1.x
		{none, "1.0.0", true},
		{none, "2.0.26", false},  // no 2.x range
		{ranged, "2.0.20", true}, // min inclusive
		{ranged, "2.0.26", true},
		{ranged, "2.0.27", false}, // max exclusive
		{ranged, "2.0.19", false},
		{ranged, "2.1.0", false},
		{ranged, "3.0.0", false}, // unknown major
		{ranged, "0.9.0", false},
		{ranged, "garbage", false},
	}
	for _, c := range cases {
		err := c.policy.Check(c.version)
		if (err == nil) != c.ok {
			t.Errorf("policy %+v Check(%q) = %v, want ok=%v", c.policy.V2, c.version, err, c.ok)
		}
	}
}

func TestLoadVersionPolicy(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	p, err := LoadVersionPolicy(write("none.json", `{ "v2": null }`))
	if err != nil || p.V2 != nil {
		t.Fatalf("null v2: %+v, %v", p, err)
	}
	p, err = LoadVersionPolicy(write("ranged.json", `{ "v2": { "min": "2.0.26", "max": "2.0.27" } }`))
	if err != nil || p.V2 == nil || p.V2.Min != (Version{2, 0, 26}) || p.V2.Max != (Version{2, 0, 27}) {
		t.Fatalf("ranged: %+v, %v", p, err)
	}
	for name, content := range map[string]string{
		"badjson.json":  `{`,
		"badver.json":   `{ "v2": { "min": "2.0", "max": "2.0.27" } }`,
		"empty.json":    `{ "v2": { "min": "2.0.27", "max": "2.0.27" } }`,
		"unknown.json":  `{ "v3": null }`,
	} {
		if _, err := LoadVersionPolicy(write(name, content)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	if _, err := LoadVersionPolicy(filepath.Join(dir, "missing.json")); err == nil || !strings.Contains(err.Error(), "missing.json") {
		t.Errorf("missing file: %v", err)
	}
}
```

Run: `cd gateway && go test -run 'TestParseVersion|TestVersionPolicyCheck|TestLoadVersionPolicy' ./...`
Expected: FAIL to compile (`ParseVersion` undefined).

- [ ] **Step 3: Implement the policy**

`gateway/versions.go`:

```go
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
)

// Version is an opencode release version, MAJOR.MINOR.PATCH.
type Version struct{ Major, Minor, Patch int }

var versionPattern = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)$`)

// ParseVersion accepts only the normalized form the CLI sends (e.g. "1.18.29").
func ParseVersion(s string) (Version, bool) {
	m := versionPattern.FindStringSubmatch(s)
	if m == nil {
		return Version{}, false
	}
	n := func(i int) int { v, _ := strconv.Atoi(m[i]); return v }
	return Version{n(1), n(2), n(3)}, true
}

func (v Version) String() string { return fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch) }

func (v Version) Less(o Version) bool {
	if v.Major != o.Major {
		return v.Major < o.Major
	}
	if v.Minor != o.Minor {
		return v.Minor < o.Minor
	}
	return v.Patch < o.Patch
}

// VersionRange holds the versions with Min <= v < Max.
type VersionRange struct{ Min, Max Version }

func (r VersionRange) Contains(v Version) bool { return !v.Less(r.Min) && v.Less(r.Max) }

// VersionPolicy says which opencode versions may register a session. Every 1.x is accepted
// (the 1.x UI build follows the pinned 1.x line); 2.x only inside V2, and nil V2 means no 2.x.
type VersionPolicy struct{ V2 *VersionRange }

// Check returns nil when a CLI reporting version may register. An empty version comes from
// CLIs that predate version reporting, which only ran opencode 1.x.
func (p VersionPolicy) Check(version string) error {
	if version == "" {
		return nil
	}
	v, ok := ParseVersion(version)
	if !ok {
		return fmt.Errorf("opencode version %q is not a MAJOR.MINOR.PATCH version", version)
	}
	switch v.Major {
	case 1:
		return nil
	case 2:
		if p.V2 == nil {
			return fmt.Errorf("opencode %s is not supported by this server: it supports opencode 1.x only", v)
		}
		if !p.V2.Contains(v) {
			return fmt.Errorf("opencode %s is not supported by this server: it supports opencode 1.x and %s up to (not including) %s", v, p.V2.Min, p.V2.Max)
		}
		return nil
	default:
		return fmt.Errorf("opencode %s is not supported by this server", v)
	}
}

// LoadVersionPolicy reads config/opencode-versions.json: {"v2": null} or
// {"v2": {"min": "2.0.26", "max": "2.0.27"}}. Unknown keys are errors.
func LoadVersionPolicy(path string) (VersionPolicy, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return VersionPolicy{}, fmt.Errorf("opencode versions file: %w", err)
	}
	var raw struct {
		V2 *struct {
			Min string `json:"min"`
			Max string `json:"max"`
		} `json:"v2"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&raw); err != nil {
		return VersionPolicy{}, fmt.Errorf("%s: %w", path, err)
	}
	if raw.V2 == nil {
		return VersionPolicy{}, nil
	}
	min, okMin := ParseVersion(raw.V2.Min)
	max, okMax := ParseVersion(raw.V2.Max)
	if !okMin || !okMax {
		return VersionPolicy{}, fmt.Errorf("%s: v2.min and v2.max must be MAJOR.MINOR.PATCH versions", path)
	}
	if !min.Less(max) {
		return VersionPolicy{}, fmt.Errorf("%s: v2.min must be lower than v2.max", path)
	}
	return VersionPolicy{V2: &VersionRange{Min: min, Max: max}}, nil
}
```

Run the Step 2 tests: expected PASS.

- [ ] **Step 4: Failing tests for the tunnel check and the stored version**

In `gateway/tunnel_test.go`, add (adapt to the file's helpers; the existing tests show the
pattern with `testRedisStore`, `mockVerifier`, `ProtocolHeader`):

```go
func TestTunnelHandlerRejectsUnsupportedOpencode(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	handler := TunnelHandler(&mockVerifier{claims: `{"email":"user@example.com","sub":"user1"}`}, nil, reg, "10.0.0.1:9090", "sub", VersionPolicy{})

	req := httptest.NewRequest("GET", "/tunnel?sessionId=s1&directory=/proj&opencodeVersion=2.0.26", nil)
	req.Header.Set(ProtocolHeader, "1")
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d", rec.Code)
	}
	if !strings.Contains(rec.Header().Get("Content-Type"), "application/json") ||
		!strings.Contains(rec.Body.String(), `"error":"opencode_unsupported"`) ||
		!strings.Contains(rec.Body.String(), "2.0.26") {
		t.Errorf("unexpected body: %s", rec.Body.String())
	}
	if _, ok, _ := store.Get(t.Context(), "s1"); ok {
		t.Error("a rejected session must not be registered")
	}
}
```

Also add a test that a real WebSocket connection with `opencodeVersion=1.18.29` registers a
session whose stored `SessionMeta.OpencodeVersion` is `"1.18.29"`, and one without the parameter
stores `""`. Find the existing test in `tunnel_test.go` that dials a real WebSocket through an
`httptest.Server` (e.g. the one around line 84 or 183) and copy its setup.

In `gateway/registry_test.go`, extend `TestTunnelRegistryRegisterAndGetTunnel` to pass
`"1.18.29"` and assert `meta.OpencodeVersion == "1.18.29"`.

Run: `cd gateway && go test ./...` — expected: compile failure (new parameters).

- [ ] **Step 5: Implement**

- `store.go`: add to `SessionMeta`, after `Directory`:
  `OpencodeVersion string \`json:"opencodeVersion,omitempty"\``
- `registry.go`: `Register(ctx, userID, email, sessionID, directory, opencodeVersion, podAddr string, tunnel *muxConn)`; set `OpencodeVersion: opencodeVersion` in the meta; add `"opencode", opencodeVersion` to the "session registered" log line.
- `tunnel.go`: `TunnelHandler(verifier, cliVerifier TokenVerifier, registry *TunnelRegistry, podAddr, userClaim string, versions VersionPolicy)`. After reading `directory` and before `upgrader.Upgrade`:

```go
		opencodeVersion := r.URL.Query().Get("opencodeVersion")
		if err := versions.Check(opencodeVersion); err != nil {
			slog.Warn("tunnel rejected: unsupported opencode", "session", sessionID, "user", userID, "email", email, "opencode", opencodeVersion)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnprocessableEntity)
			json.NewEncoder(w).Encode(map[string]string{"error": "opencode_unsupported", "message": err.Error()})
			return
		}
```

  and pass `opencodeVersion` to `registry.Register`.
- `config.go`: add `OpencodeVersionsFile string` to `Config`, from env `OPENCODE_VERSIONS_FILE`,
  default `/etc/opencode-rc/opencode-versions.json`.
- `main.go`: load the policy at startup with `LoadVersionPolicy(cfg.OpencodeVersionsFile)`.
  If the env var is unset and the default file does not exist (`errors.Is(err, fs.ErrNotExist)`),
  log a warning and use `VersionPolicy{}` (no 2.x), so a locally built binary still starts. Any
  other error (or a missing file named explicitly by the env var) is fatal, like other config
  errors in `main.go`. Log the loaded policy once (`"opencode versions", "v2", ...`). Pass the
  policy through `routes_gateway.go` to `TunnelHandler`.
- Update every test call: `Register(..., directory, "", podAddr, mux)` (or a real version where
  the test checks it) and `TunnelHandler(..., "sub", VersionPolicy{})`.
- `gateway/Dockerfile` final stage: `COPY config/opencode-versions.json /etc/opencode-rc/opencode-versions.json`
  (build context is the repo root; check `.dockerignore` does not exclude `config/`).

- [ ] **Step 6: Run the gateway tests and build the image**

```bash
cd gateway && go vet ./... && go test ./...
cd .. && docker build -f gateway/Dockerfile -t opencode-rc-gateway:step2 . \
  && docker run --rm --entrypoint "" opencode-rc-gateway:step2 /opencode-rc --help 2>&1 | head -3 ; true
```

Expected: vet clean, all tests pass; image builds. (distroless has no shell; to confirm the file
is in the image use `docker create` + `docker cp <id>:/etc/opencode-rc/opencode-versions.json -`,
then `docker rm`.)

- [ ] **Step 7: Commit**

```bash
git add config/opencode-versions.json gateway
git commit -m "feat(gateway): store the opencode version and reject unsupported ones"
```

---

### Task 2: CLI — detect, refuse 2.x, report the version

**Files:**
- Create: `cli/src/opencode-version.ts`, `cli/test/opencode-version.test.ts`
- Modify: `cli/src/index.ts`, `cli/src/tunnel.ts` (`startTunnel`, `startTunnelWithReconnect`)
- Test: `cli/test/opencode-version.test.ts`, `cli/test/tunnel.test.ts`

**Interfaces:**
- Consumes: gateway `/tunnel?...&opencodeVersion=<v>`; 422 `{"error":"opencode_unsupported","message":...}` (Task 1).
- Produces: `parseOpencodeVersion(output: string): string | null`, `detectOpencodeVersion(run?: () => string): string`.

- [ ] **Step 1: Failing tests**

`cli/test/opencode-version.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseOpencodeVersion, detectOpencodeVersion } from "../src/opencode-version.js";

describe("parseOpencodeVersion", () => {
  it("reads the 1.x output", () => {
    expect(parseOpencodeVersion("1.18.29\n")).toBe("1.18.29");
  });
  it("reads the 2.x output", () => {
    expect(parseOpencodeVersion("opencode v2.0.26\n")).toBe("2.0.26");
  });
  it("rejects output without a version", () => {
    expect(parseOpencodeVersion("")).toBeNull();
    expect(parseOpencodeVersion("opencode dev")).toBeNull();
  });
});

describe("detectOpencodeVersion", () => {
  it("returns the parsed version", () => {
    expect(detectOpencodeVersion(() => "1.18.29\n")).toBe("1.18.29");
  });
  it("explains a missing opencode", () => {
    expect(() =>
      detectOpencodeVersion(() => {
        throw Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
      }),
    ).toThrow(/opencode is not installed or not on PATH/);
  });
  it("explains unreadable output", () => {
    expect(() => detectOpencodeVersion(() => "opencode dev")).toThrow(/could not read the opencode version/);
  });
});
```

In `cli/test/tunnel.test.ts`, update the test "sends sessionId, directory, and auth header on
connect" to call `startTunnel(..., directory, "1.18.29")` and assert the request URL contains
`opencodeVersion=1.18.29`. Add a test that a pre-flight response of `422` with body
`{"error":"opencode_unsupported","message":"opencode 2.0.26 is not supported by this server: it supports opencode 1.x only"}`
makes `startTunnel` reject with a `ProtocolError` whose message equals that `message`. Follow the
file's existing pre-flight mocking (see how the 426 `client_outdated` case is set up, if there is
a test for it; otherwise mock `fetch` the same way the file mocks the gateway).

Run: `cd cli && npm test` — expected: FAIL (module missing, new parameter).

- [ ] **Step 2: Implement**

`cli/src/opencode-version.ts`:

```ts
import { execFileSync } from "node:child_process";

// `opencode --version` prints "1.18.29" on 1.x and "opencode v2.0.26" on 2.x.
export function parseOpencodeVersion(output: string): string | null {
  const m = output.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

const runOpencodeVersion = () =>
  execFileSync("opencode", ["--version"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });

export function detectOpencodeVersion(run: () => string = runOpencodeVersion): string {
  let output: string;
  try {
    output = run();
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error("opencode is not installed or not on PATH. Install opencode first.");
    throw new Error(`could not run "opencode --version": ${err?.message ?? err}`);
  }
  const version = parseOpencodeVersion(output);
  if (!version) throw new Error(`could not read the opencode version from "opencode --version": ${output.trim()}`);
  return version;
}
```

`cli/src/tunnel.ts`: add a parameter `opencodeVersion: string` after `directory` to `startTunnel`
and `startTunnelWithReconnect` (pass it through). Build the path as:

```ts
  const tunnelPath =
    `/tunnel?sessionId=${encodeURIComponent(sessionID)}&directory=${encodeURIComponent(directory)}` +
    `&opencodeVersion=${encodeURIComponent(opencodeVersion)}`;
```

In the pre-flight, next to the 426 handling:

```ts
    if (resp.status === 422) {
      const body = (await resp.clone().json().catch(() => ({}))) as { error?: string; message?: string };
      if (body.error === "opencode_unsupported") {
        throw new ProtocolError(body.message ?? "This server does not support the installed opencode version.");
      }
    }
```

`cli/src/index.ts`: before `const server = await startServer();`:

```ts
  let opencodeVersion: string;
  try {
    opencodeVersion = detectOpencodeVersion();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const major = Number(opencodeVersion.split(".")[0]);
  if (major !== 1) {
    console.error(
      major === 2
        ? `opencode 2.x needs a newer opencode-rc (found opencode ${opencodeVersion}). Use opencode 1.x for now.`
        : `opencode ${opencodeVersion} is not supported. opencode-rc supports opencode 1.x.`,
    );
    process.exit(1);
  }
  console.log(`opencode ${opencodeVersion}`);
```

and pass `opencodeVersion` to `startTunnelWithReconnect` after `process.cwd()`.

- [ ] **Step 3: Run tests and build**

```bash
cd cli && npm run build && npx -y node@22 node_modules/vitest/vitest.mjs run
```

Expected: build OK; all tests pass (count = previous + new).

- [ ] **Step 4: Commit**

```bash
git add cli/src cli/test
git commit -m "feat(cli): report the opencode version and refuse opencode 2.x for now"
```

---

### Task 3: API and UI — pass the version through and show it

**Files:**
- Modify: `api/src/store.ts` (`SessionMeta`)
- Modify: `ui/src/api.ts` (`DevSession`), `ui/src/session-picker.tsx`
- Test: `ui/src/session-picker.test.tsx`; `e2e/e2e.test.ts` ("session metadata")

**Interfaces:**
- Consumes: session record field `opencodeVersion` (optional string, Task 1).
- Produces: `DevSession.opencodeVersion?: string`; step 4's picker routing reads it.

- [ ] **Step 1: Failing UI test**

In `ui/src/session-picker.test.tsx`, following the "renders session cards" test's mocking, add:

```tsx
  it("shows the opencode version when the session reports one", async () => {
    // mock fetchSessions (as the neighbouring tests do) to return two sessions:
    //   { id: "a", directory: "/p/a", createdAt: <now>, opencodeVersion: "1.18.29", ... }
    //   { id: "b", directory: "/p/b", createdAt: <now>, ... }   // no version (older CLI)
    render(() => <SessionPicker user={user} />)
    expect(await screen.findByText("opencode 1.18.29")).toBeInTheDocument()
    expect(screen.queryAllByText(/^opencode \d/)).toHaveLength(1)
  })
```

Write it with the exact mock style the file uses. Run:
`cd ui && npx -y node@22 node_modules/vitest/vitest.mjs run src/session-picker.test.tsx` — expected FAIL.

- [ ] **Step 2: Implement**

- `api/src/store.ts` `SessionMeta`: add `opencodeVersion?: string;` (the route already spreads the record).
- `ui/src/api.ts` `DevSession`: add `opencodeVersion?: string`.
- `ui/src/session-picker.tsx`: in the card's footer line next to `Connected {timeAgo(...)}`,
  render `<span>opencode {props.session.opencodeVersion}</span>` only when the field is set
  (`<Show when={props.session.opencodeVersion}>`), styled like the neighbouring span.

- [ ] **Step 3: e2e assertion**

In `e2e/e2e.test.ts` "session metadata" → "session has expected fields", add:

```ts
    // The dev machine runs the opencode pinned in cli/Dockerfile (OPENCODE_VERSION).
    expect(session.opencodeVersion).toBe("1.18.29");
```

(Do not run e2e; the controller runs it after all tasks.)

- [ ] **Step 4: Run tests**

```bash
cd ui && bun run typecheck && npx -y node@22 node_modules/vitest/vitest.mjs run
cd ../api && bun run typecheck && npx -y node@22 node_modules/vitest/vitest.mjs run
cd ../e2e && npx tsc --noEmit -p tsconfig.json
```

Expected: ui 211+ tests pass (none skipped), api 323 pass, e2e type-checks (install its deps with
`npm ci` first if `e2e/node_modules` is missing — e2e uses npm, see `e2e/package-lock.json`).

- [ ] **Step 5: Commit**

```bash
git add api/src/store.ts ui/src e2e/e2e.test.ts
git commit -m "feat(ui): show each dev machine's opencode version"
```

---

## After the tasks (controller)

- Run e2e on kind (`KUBE_CONTEXT=kind-gen1 NAMESPACE=opencode-rc-e2e-v2 ./e2e/run.sh`): the dev
  machine must register with `opencodeVersion` `1.18.29` and all suites stay green.
- Docs: none in this step (no user-facing config yet). The CLI's new 2.x message and the
  gateway's rejection get documented with step 4/5.
