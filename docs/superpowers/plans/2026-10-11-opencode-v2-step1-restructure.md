# opencode 2.0 Support, Step 1: Restructure for a Second opencode Version

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make room for opencode 2.x next to 1.x without changing behaviour: rename the opencode
submodule to `vendor/opencode-v1`, move the 1.x patches to `vendor/patches/v1/`, and move the UI
build to Vite 8.

**Architecture:** Pure restructure. The 1.x UI keeps building from the renamed submodule into
`ui/dist/` at the root, with the same patches, config and output. Nothing for 2.x is added yet
(the `vendor/opencode-v2` submodule arrives in step 4).

**Tech Stack:** git submodules, Bun, Vite 8, vitest 5 on Node 22, GitHub Actions, Docker.

**Spec:** `docs/superpowers/specs/2026-10-11-opencode-v2-support-design.md` (sections
"Repository layout" and "Decisions" item 6).

## Global Constraints

- Work in the worktree `.claude/worktrees/staging+v2` on branch `staging/v2`. Never push; never merge.
- Behaviour must not change: same UI output at the root, same patches applied for the same config.
- Package managers: `bun` in `ui/`, `api/`, `vendor/opencode-v1`; never `npm install` there.
- Unit tests must also pass on Node 22: `npx -y node@22 node_modules/vitest/vitest.mjs run` in `ui/` (and `api/` when it is touched).
- Commit messages: `<type>: <short description>`, types feat/fix/refactor/chore/docs/build/test; no attribution lines, no mention of Claude. Commits are GPG-signed automatically; never disable signing.
- No version bumps (package.json versions, chart, iOS/Android versions).
- Committed text must not name `.local/`, `LOCAL.md`, private hostnames or IPs.
- Leave `docs/superpowers/plans/*` and `docs/superpowers/specs/*` of earlier work unchanged (historical).
- Vite 8 pins (verbatim): `vite 8.2.2`, `vite-plugin-solid 2.11.14`, `tailwindcss 4.3.3`, `@tailwindcss/vite 4.3.3`.

## Baseline (record before Task 1)

Run once in `ui/` and keep the numbers; later tasks compare against them.

```bash
cd ui
bun run typecheck                                  # expect: 0 error(s) in ui
npx -y node@22 node_modules/vitest/vitest.mjs run  # expect: Test Files 19 passed, Tests 210 passed, none skipped
env -u OPENCODE_RC_CONFIG bun run build            # expect: ✓ built
```

The patch tests use `describe.skipIf(!exists(submodule))`. A wrong submodule path makes them
**skip, not fail**, so every test run in this plan must show the same passed count and **no
skipped** tests.

---

### Task 1: Rename the submodule to `vendor/opencode-v1`

**Files:**
- Move: `vendor/opencode` → `vendor/opencode-v1` (`.gitmodules` updated by `git mv`)
- Modify: `ui/vite.config.ts:12` (default `opencodeRoot`)
- Modify: `ui/tsconfig.json:18,21`
- Modify: `ui/build/typecheck.ts:2,21`
- Modify: `ui/build/locales-config.ts:11`
- Modify: `ui/build/locales-config.test.ts:6,10`
- Modify: `ui/build/upload-patches.test.ts:8`, `ui/build/terminal-patches.test.ts:8`, `ui/build/feature-patch-sets.test.ts:9`
- Modify: `ui/web/Dockerfile:3-6,20`
- Modify: `.github/workflows/ui.yml`, `android.yml`, `ios.yml`, `e2e.yml` (path filters and `cd vendor/opencode`)
- Modify: `AGENTS.md`, `CONTRIBUTING.md`, `.claude/skills/check-versions.md`, `cli/Dockerfile:4` (comment)

**Interfaces:**
- Produces: the 1.x opencode source at `vendor/opencode-v1`. Task 2 and later steps use this path.

- [ ] **Step 1: Move the submodule**

```bash
git mv vendor/opencode vendor/opencode-v1
git diff --cached .gitmodules
```

Expected: `.gitmodules` now has `path = vendor/opencode-v1`. The section name stays
`[submodule "vendor/opencode"]`; leave it (renaming it would require moving the submodule's git
dir in every clone). `git -C vendor/opencode-v1 describe --tags` prints the same tag as before
(`v1.18.29`). If `git mv` refuses in the worktree, stop and report; do not deinit or delete anything.

- [ ] **Step 2: Run the tests to see the stale paths**

```bash
cd ui && npx -y node@22 node_modules/vitest/vitest.mjs run 2>&1 | tail -5
```

Expected: failures (`locales-config` cannot import from `vendor/opencode`) and/or skipped patch
tests. This confirms the tests depend on the path.

- [ ] **Step 3: Update the UI build paths**

In `ui/vite.config.ts` line 12:

```ts
const opencodeRoot = process.env.OPENCODE_ROOT || path.resolve(__dirname, "../vendor/opencode-v1")
```

In `ui/tsconfig.json`, both `paths` entries:

```json
      "@opencode-ai/app": [
        "../vendor/opencode-v1/packages/app/src/index.ts"
      ],
      "@/*": [
        "../vendor/opencode-v1/packages/app/src/*"
      ]
```

In `ui/build/typecheck.ts`, line 2 becomes
`// submodule's source (installed with \`cd vendor/opencode-v1 && bun install\`), so tsc also checks`
and line 21 becomes:

```ts
console.log(`typecheck: ${errors.length} error(s) in ui, ${vendor.length} in vendor/opencode-v1 (ignored)`)
```

(The filter `line.startsWith("../vendor/")` stays as is.)

In `ui/build/locales-config.ts` line 11 and `ui/build/locales-config.test.ts` lines 6 and 10,
replace `../../vendor/opencode/` with `../../vendor/opencode-v1/`.

In `ui/build/upload-patches.test.ts:8`, `ui/build/terminal-patches.test.ts:8` and
`ui/build/feature-patch-sets.test.ts:9`:

```ts
const opencode = fileURLToPath(new URL("../../vendor/opencode-v1", import.meta.url))
```

- [ ] **Step 4: Run typecheck, tests and build**

```bash
cd ui
bun run typecheck
npx -y node@22 node_modules/vitest/vitest.mjs run
env -u OPENCODE_RC_CONFIG bun run build
```

Expected: `0 error(s) in ui, N in vendor/opencode-v1 (ignored)`; tests match the baseline
(19 files, 210 tests passed, none skipped); build succeeds.

- [ ] **Step 5: Update the UI image and CI**

`ui/web/Dockerfile` lines 3-6 and 20:

```dockerfile
COPY vendor/opencode-v1/package.json vendor/opencode-v1/bun.lock vendor/opencode-v1/
COPY vendor/opencode-v1/patches/ vendor/opencode-v1/patches/
COPY vendor/opencode-v1/packages/ vendor/opencode-v1/packages/
RUN cd vendor/opencode-v1 && bun install --frozen-lockfile --ignore-scripts
```

```dockerfile
    && OPENCODE_ROOT=/src/vendor/opencode-v1 bun run build \
```

In `.github/workflows/ui.yml`, `android.yml`, `ios.yml` and `e2e.yml`: every path filter
`- 'vendor/opencode'` becomes `- 'vendor/opencode-v1'`, and every `cd vendor/opencode &&`
becomes `cd vendor/opencode-v1 &&`. Leave `- 'vendor/patches/**'` as is.

Check nothing is left:

```bash
git grep -n "vendor/opencode\b" -- .github ui/web ui/build ui/vite.config.ts ui/tsconfig.json | grep -v "opencode-v1"
```

Expected: no output.

- [ ] **Step 6: Build the UI image and smoke-test it**

```bash
docker build -f ui/web/Dockerfile -t opencode-rc-ui:step1 .
ui/web/smoke-test.sh opencode-rc-ui:step1
```

Expected: build succeeds; smoke test passes. If Docker is unavailable, say so in the report;
do not skip silently.

- [ ] **Step 7: Update the docs**

In `AGENTS.md`, `CONTRIBUTING.md`, `.claude/skills/check-versions.md` and the comment in
`cli/Dockerfile:4`, replace the path `vendor/opencode` with `vendor/opencode-v1` (structure
listings, submodule bump commands, `cd vendor/opencode && bun install`, the package-manager line,
the `ui/**`, `vendor/opencode` trigger lists). In AGENTS.md's submodule section, also say that
the submodule holds opencode 1.x and that 2.x support (a second submodule) is in progress, in
one sentence. Leave the patch paths (`vendor/patches/...`) for Task 2.

```bash
git grep -n "vendor/opencode\b" -- AGENTS.md CONTRIBUTING.md .claude cli/Dockerfile | grep -v "opencode-v1"
```

Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add -A .gitmodules vendor/opencode-v1 ui .github AGENTS.md CONTRIBUTING.md .claude/skills/check-versions.md cli/Dockerfile
git status -s   # only the intended files; no ui/dist
git commit -m "build: rename the opencode submodule to vendor/opencode-v1"
```

---

### Task 2: Move the 1.x patches to `vendor/patches/v1/`

**Files:**
- Move: `vendor/patches/{export,share,shell,terminal,uploads}` → `vendor/patches/v1/{...}`
- Modify: `ui/vite.config.ts` (the `featurePatches(...)` call, around line 158)
- Modify: `ui/build/vendor-patches.ts` (comments naming `vendor/patches/<feature>/` and `vendor/opencode`)
- Modify: `ui/build/vendor-patches.test.ts:107,134`
- Modify: `ui/build/feature-patch-sets.test.ts:10`, `ui/build/upload-patches.test.ts:9`, `ui/build/terminal-patches.test.ts:9`
- Modify: `config/schema.ts:5`, `api/src/feature-guards.ts:13` (comments)
- Modify: `AGENTS.md` (Patches section and "Adding a feature toggle")

**Interfaces:**
- Consumes: `vendor/opencode-v1` from Task 1.
- Produces: 1.x patches at `vendor/patches/v1/<feature>/*.patch`, still paths relative to the
  opencode root. Step 4 adds `vendor/patches/v2/`. `featurePatches(patchesRoot, features, disabled)`
  keeps its signature; callers pass the per-version root.

- [ ] **Step 1: Point the real-patches test at the new root (failing test first)**

In `ui/build/vendor-patches.test.ts`, line 107's comment becomes
`// vendor/patches/<version> with a directory per feature`, and the test at line 133 becomes
(the `readdirSync` line matters: `featurePatches` accepts a missing root, so without it the test
would pass against a wrong path):

```ts
  it("matches the features in the real vendor/patches/v1", () => {
    const real = fileURLToPath(new URL("../../vendor/patches/v1", import.meta.url))
    expect(fs.readdirSync(real).sort()).toEqual(["export", "share", "shell", "terminal", "uploads"])
    expect(() => featurePatches(real, FEATURES, [])).not.toThrow()
  })
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ui && npx -y node@22 node_modules/vitest/vitest.mjs run build/vendor-patches.test.ts
```

Expected: FAIL with `ENOENT` for `vendor/patches/v1`.

- [ ] **Step 3: Move the patch directories**

```bash
mkdir vendor/patches/v1
git mv vendor/patches/export vendor/patches/share vendor/patches/shell vendor/patches/terminal vendor/patches/uploads vendor/patches/v1/
ls vendor/patches vendor/patches/v1
```

Expected: `vendor/patches` contains only `v1`; `vendor/patches/v1` contains the five feature dirs.

- [ ] **Step 4: Update the build and the remaining tests**

`ui/vite.config.ts`, the plugin entry:

```ts
    // vendor/patches/v1/<feature>: our changes to opencode 1.x, applied when the feature is disabled.
    vendorPatches(
      opencodeRoot,
      featurePatches(
        path.resolve(__dirname, "../vendor/patches/v1"),
        FEATURES,
        FEATURES.filter((name) => !rcConfig.features[name].enabled),
      ),
    ),
```

`ui/build/feature-patch-sets.test.ts:10`:

```ts
const patchesRoot = fileURLToPath(new URL("../../vendor/patches/v1", import.meta.url))
```

`ui/build/upload-patches.test.ts:9` and `ui/build/terminal-patches.test.ts:9`: replace
`../../vendor/patches/uploads` / `../../vendor/patches/terminal` with
`../../vendor/patches/v1/uploads` / `../../vendor/patches/v1/terminal`.

Comments: in `ui/build/vendor-patches.ts`, `vendor/patches/<feature>/` becomes
`vendor/patches/<version>/<feature>/` and "relative to vendor/opencode" becomes "relative to the
opencode root (e.g. vendor/opencode-v1)". `config/schema.ts:5` and `api/src/feature-guards.ts:13`:
`vendor/patches/<name>/` becomes `vendor/patches/v1/<name>/`.

- [ ] **Step 5: Run typecheck, tests and two builds**

```bash
cd ui
bun run typecheck
npx -y node@22 node_modules/vitest/vitest.mjs run
env -u OPENCODE_RC_CONFIG bun run build
OPENCODE_RC_CONFIG=$PWD/../e2e/rc-config.json bun run build
```

Expected: typecheck 0 errors in ui; tests 19 files / 210 passed, none skipped; both builds succeed
(the second applies the uploads and terminal patches). Then:

```bash
cd ../api && bun run typecheck && npx -y node@22 node_modules/vitest/vitest.mjs run
```

Expected: pass (only a comment changed, but `api/` was touched).

- [ ] **Step 6: Update AGENTS.md**

In the Patches section: patches live in `vendor/patches/v1/<feature>/*.patch` (paths relative to
`vendor/opencode-v1`), e.g. `vendor/patches/v1/uploads/` for `features.uploads`. The example
commands become:

```bash
# Change a patch: apply it, edit the files, write it back, reset the submodule
cd vendor/opencode-v1
git apply ../patches/v1/uploads/composer-v1.patch
# ...edit packages/app/src/components/prompt-input.tsx...
git diff -- packages/app/src/components/prompt-input.tsx packages/app/src/components/prompt-input/attachments.ts > ../patches/v1/uploads/composer-v1.patch
git checkout -- .

# After bumping opencode: rebase each patch onto the new tag
git apply --3way ../patches/v1/uploads/composer-v1.patch   # resolve conflicts, then write it back as above
```

Add one sentence: the `composer-v1`/`composer-v2` file names refer to opencode 1.x's two prompt
composers, not to opencode versions. In "Adding a feature toggle" step 2:
`vendor/patches/v1/<name>/*.patch`. Structure listing line 20:
`vendor/patches  # Our patches to opencode, per opencode version (v1/), applied by the UI build per disabled feature`.

```bash
git grep -nE "vendor/patches/(export|share|shell|terminal|uploads|<feature>|<name>)" -- AGENTS.md CONTRIBUTING.md README.md ui api config .github
git grep -nE "\.\./patches/(export|share|shell|terminal|uploads)" -- AGENTS.md CONTRIBUTING.md
```

Expected: no output from either.

- [ ] **Step 7: Commit**

```bash
git add -A vendor/patches ui config/schema.ts api/src/feature-guards.ts AGENTS.md
git status -s
git commit -m "build: move the opencode 1.x patches to vendor/patches/v1"
```

---

### Task 3: Build the UI with Vite 8

**Files:**
- Modify: `ui/package.json`, `ui/bun.lock`
- Modify: `ui/vite.config.ts` (config-loader warnings)
- Create: `config/package.json`

**Interfaces:**
- Consumes: Tasks 1-2 paths.
- Produces: `ui/` on Vite 8.2.2; step 4's 2.x build uses the same toolchain.

- [ ] **Step 1: Pin the toolchain and install**

In `ui/package.json` devDependencies set exactly:

```json
    "@tailwindcss/vite": "4.3.3",
    "tailwindcss": "4.3.3",
    "vite": "8.2.2",
    "vite-plugin-solid": "2.11.14",
```

```bash
cd ui && bun install && grep -oE '"vite@[0-9.]+"' bun.lock | sort -u
```

Expected: `"vite@8.2.2"` only.

- [ ] **Step 2: Build and record the config-loader warning**

```bash
env -u OPENCODE_RC_CONFIG bun run build 2>&1 | head -12
```

Expected: build succeeds and prints a `configLoader: 'native'` warning listing `__dirname`,
extensionless imports in `vite.config.ts`, and "ESM syntax in a file loaded as CommonJS
(../config/schema.ts)".

- [ ] **Step 3: Fix the warnings**

In `ui/vite.config.ts`:
- replace every `__dirname` with `import.meta.dirname` (lines 12, 47, 158 and `server.fs.allow`);
- add the `.ts` extension to the three local imports:

```ts
import { FEATURES, parseConfig, parseConfigText, type RcConfig } from "../config/schema.ts"
import { contentSecurityPolicy } from "./csp.ts"
import { featurePatches, vendorPatches } from "./build/vendor-patches.ts"
```

Create `config/package.json`:

```json
{
  "type": "module"
}
```

- [ ] **Step 4: Verify the warning is gone and nothing else changed**

```bash
cd ui
env -u OPENCODE_RC_CONFIG bun run build 2>&1 | grep -c "configLoader" ; true
OPENCODE_RC_CONFIG=$PWD/../e2e/rc-config.json bun run build
bun run typecheck
npx -y node@22 node_modules/vitest/vitest.mjs run
cd ../api && bun run typecheck && npx -y node@22 node_modules/vitest/vitest.mjs run
```

Expected: the grep count is `0`; both builds succeed; ui typecheck 0 errors; ui tests 19 files /
210 passed, none skipped; api typecheck and tests pass (they import `config/schema.ts`, now in an
ESM package). If `config/package.json` breaks the API, remove it, keep the other fixes, and report
the remaining warning instead of working around it.

- [ ] **Step 5: Check the built page**

```bash
cd ui && (npx vite preview --port 4181 --strictPort --host 127.0.0.1 &) && sleep 3
curl -s http://127.0.0.1:4181/ | grep -o "<title>[^<]*</title>"
pkill -f "vite preview --port 4181"
```

Expected: `<title>OpenCode RC</title>`. (A browser check of the login screen is optional; the
controller verified it during design.)

- [ ] **Step 6: Rebuild the UI image**

```bash
docker build -f ui/web/Dockerfile -t opencode-rc-ui:step1 .
ui/web/smoke-test.sh opencode-rc-ui:step1
```

Expected: build and smoke test pass (the image copies `config/`, now including `package.json`).

- [ ] **Step 7: Commit**

```bash
git add ui/package.json ui/bun.lock ui/vite.config.ts config/package.json
git status -s
git commit -m "build: build the UI with Vite 8"
```

---

## After the tasks

- Remove local build output (`ui/dist`) if it differs from what the main checkout expects; it is gitignored.
- Report to the user: commits, test counts, image smoke test result. Merging `staging/v2` into
  `main` (fast-forward) and pushing are the user's decisions.
- Other clones need `git submodule sync && git submodule update --init` after pulling (the
  submodule path changed); mention it in the report.
