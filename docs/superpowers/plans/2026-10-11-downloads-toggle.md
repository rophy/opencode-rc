# `downloads` Feature Toggle (opencode 1.x and 2.x) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new toggle `downloads`, for both opencode versions. When disabled, the API refuses
requests that return a file's contents, and the UI loses the controls that open files. Together
with `uploads` disabled, nothing goes onto or comes off a dev machine through opencode-rc,
except chat text and diff hunks.

**Design (agreed with the user, 2026-10-11):**
- Separate toggles `uploads` (existing) and `downloads` (new), not one combined toggle: no config
  migration, and deployments can allow one direction only.
- Block file **contents** only. Listing directories and file-name search stay allowed (names are
  already visible through `@` mentions and diffs; listing powers the 2.x workspace picker and the
  file tree).
- Blocked by the API when disabled:
  - 1.x sessions: `GET /file/content` and `GET /api/fs/read/*` (opencode 1.18 serves both).
  - 2.x sessions: `GET /api/fs/read/*` (any path, including absolute paths).
- UI patches remove the actions that open a file's contents: open-file tabs, `mod+p` / `/open`,
  the command palette's file search, opening a file from the file tree or from the diff, and
  (2.x) the link handler that opens any path. The file tree may stay for browsing if clicking a
  file can be made inert; otherwise hide it and say so in the report.
- Still works: chat, diff hunks (from `vcs/diff`), `@` mentions (name search; the dev machine
  reads the file), 2.x directory picking. Lost: the diff's "expand to full file" context,
  chat images loaded from disk (2.x).
- Not prevented (README must say so): the AI printing a file's contents into the chat when asked,
  and the changed lines shown in diffs. Keeping code on a machine needs opencode's own permission
  config there.

**Tech Stack:** TypeScript (API, UI, schema), jsdiff patches applied at build time, vitest, Playwright e2e on kind.

**Spec:** this plan's Design section; repo rules in AGENTS.md "Adding a feature toggle".

## Global Constraints

- Work in the worktree `.claude/worktrees/staging+v2` on branch `staging/v2`. Never push; never merge.
- Toggle name verbatim: `downloads`, in both `FEATURES` (1.x, `features.downloads`) and `FEATURES_V2` (2.x, `opencodeV2.features.downloads`); default enabled; independent per version.
- Rejections: 1.x sessions 403 text (like the other 1.x guards), message `file downloads are disabled`; 2.x sessions 400 `{"_tag":"FeatureDisabled","message":"file downloads are disabled"}`.
- Guards match canonical paths (`canonicalPath` in api/src/proxy.ts) for GET requests, like `terminal-guard.ts`; a path that can't be canonicalized counts as blocked.
- Patches: plain `git diff` output relative to the submodule root, edits of existing files only, no fuzz; every combination of disabled features must still apply (existing combination tests); leave the submodules clean.
- Package managers: bun in `api/`, `ui/`; npm in `e2e/`. Tests on Node 22: `npx -y node@22 node_modules/vitest/vitest.mjs run`.
- Commit messages: `<type>: <short description>`; no attribution lines, no mention of Claude. GPG signing is automatic; never disable it.
- No version bumps. Committed text must not name `.local/`, `LOCAL.md`, private hostnames or IPs.
- The controller runs the e2e suite; implementers don't run kubectl, make, or e2e/run.sh.

---

### Task 1: Schema and API guards

**Files:**
- Modify: `config/schema.ts` (`FEATURES`, `FEATURES_V2`)
- Create: `api/src/download-guard.ts`, `api/src/download-guard.test.ts`
- Modify: `api/src/feature-guards.ts` (`FEATURE_GUARDS.downloads`), `api/src/v2-routes.ts` (`GET /api/fs/read/*` → `"downloads"`), `api/src/v2-guard.ts` (message), tests in `api/src/v2-guard.test.ts`, `api/src/rc-config.test.ts` (defaults)

**Interfaces:**
- Produces: `downloadGuard(): MiddlewareHandler<ProxyEnv>` (1.x) and the 2.x route tag. Tasks 2-4 rely on `features.downloads` / `opencodeV2.features.downloads`.

- [ ] Add `"downloads"` to both feature lists (after `"uploads"`), with a comment on what it blocks.
- [ ] 1.x guard (`download-guard.ts`, modeled on `terminal-guard.ts`): for GET/HEAD, if
  `canonicalPath(proxyRest(...))` is null, or equals `/file/content`, or starts with
  `/api/fs/read/` → log `downloads blocked user=… METHOD path` and return 403 text
  `file downloads are disabled`; otherwise next. Tests: those paths blocked (including encoded
  variants that canonicalize to them, and `HEAD`), `/file` (listing), `/find/file`, `/api/fs/list`,
  `/api/fs/find` and `/session` pass; a non-GET to `/file/content` is not this guard's concern
  (it passes to the others).
- [ ] `FEATURE_GUARDS.downloads = downloadGuard()`.
- [ ] 2.x: change `["GET", "/api/fs/read/*", "allow"]` to `"downloads"` in `v2-routes.ts`, add
  `downloads: "file downloads are disabled"` to the v2 guard's messages; v2-guard tests: with
  downloads disabled `GET /api/fs/read/src/a.ts` → 400 FeatureDisabled with that message; enabled → forwarded;
  `GET /api/fs/list` and `/api/fs/find` → forwarded either way.
- [ ] Schema tests: both new toggles default to enabled and parse when disabled.
- [ ] `cd api && bun run typecheck && npx -y node@22 node_modules/vitest/vitest.mjs run`; `cd ../ui && bun run typecheck`.
  Commit — `feat: downloads toggle, enforced by the API`

### Task 2: 1.x UI patch

**Files:**
- Create: `vendor/patches/v1/downloads/*.patch`, `ui/build/download-patches.test.ts`

Entry points found in vendor/opencode-v1/packages/app/src (from research; verify each):
- `pages/session/session-side-panel.tsx`: "+" button in the tab strip (legacy ~446-460 opens `DialogSelectFile`; new layout ~651-681 `openFileBrowser()`), the open-file browser tab (`SessionFileBrowserTab`, mounted ~738), file tabs, the "All" file tree (~832; clicking calls `openTab(file.tab(path))`).
- `pages/session/v2/session-file-browser-tab.tsx` (search + tree + list).
- `pages/session/use-session-commands.tsx:518` `file.open` (`mod+p`, `/open`); session header button `components/session/session-header.tsx:162,300`; command palette entry `pages/session.tsx:1152`; file search sources in `components/dialog-select-file.tsx:92-98` and `dialog-command-palette-v2.tsx:44`.
- `pages/session.tsx:1289` `onViewFile={openReviewFile}` (open a diff's file as a tab), `review-tab.tsx:27`.

- [ ] Write the smallest patches that make those actions unavailable (prefer chokepoints: disable/hide the `file.open` command, remove the "+" and open-file tab, make tree clicks and `onViewFile` not open file tabs, drop file search from the palette). Keep `@` mentions and the diff view working. Prefer keeping the tree visible but inert; if not feasible cleanly, hide the "All" tree and note it.
- [ ] Tests (`download-patches.test.ts`, modeled on `upload-patches.test.ts`): assert on the patched sources that each entry point is gone/inert. The existing combination test (`feature-patch-sets.test.ts`) must pass with `downloads` included.
- [ ] Builds: `OPENCODE_RC_CONFIG` with `features.downloads` disabled, and all 1.x features disabled, `bun run build:v1` both succeed.
- [ ] Commit — `feat(ui): hide file opening in the 1.x UI when downloads are disabled`

### Task 3: 2.x UI patch

**Files:**
- Create: `vendor/patches/v2/downloads/*.patch`, add to `ui/build/v2-patches.test.ts`

Entry points found in vendor/opencode-v2 (verify each):
- `packages/gui-extensions/src/file/renderer.tsx`: the "Open" `MenuItem` (~283-304, menu `session.panel`, keybind `file.open`), the `LinkHandler` with `match: () => true` (~415; opens any path from chat, including absolute ones), the sidebar slot (~359).
- `packages/gui-extensions/src/file/browser.tsx` (the OPEN tab with workspace search).
- `packages/app/src/session/commands/use-session-commands.tsx:334-340` `file.open` (`mod+p`, `/open`); `packages/app/src/shell/commands/dialog.tsx:46-52` (palette file search, wired from `app/session/composer/region.tsx:234`).
- Review clicks: `gui-extensions/src/review/panel.tsx` `focusFile` (focus a diff; keep), review `LinkHandler` (`review/renderer.tsx:212`).
- Do NOT drop the whole `file` extension: the review panel's file list uses its `FileTree` contract (`review/index.ts:24`, `panel.tsx:280`).

- [ ] Smallest patches: remove the Open menu item and tab, make the file `LinkHandler` not open files (or match nothing), disable/hide `file.open`, drop palette file search; keep the review panel's diffs and file list, `@` mentions. Tree: keep visible but inert if feasible, else hide and note.
- [ ] Tests in `v2-patches.test.ts`: per entry point, assert on patched sources; all combinations apply.
- [ ] Builds: `opencodeV2.features.downloads` disabled alone, and all 2.x features disabled: `bun run build:v2` succeeds.
- [ ] Commit — `feat(ui): hide file opening in the 2.x UI when downloads are disabled`

### Task 4: e2e and docs

**Files:**
- Modify: `e2e/rc-config.json` and `e2e/values.yaml` (disable `downloads` for both versions, like `uploads`), `e2e/e2e.test.ts` and `e2e/v2.test.ts` (API checks), `e2e/playwright/web-ui.spec.ts` and `e2e/playwright/v2.spec.ts` (UI checks), `README.md` (Deployment Config), `AGENTS.md` (feature list if it enumerates toggles)

- [ ] API e2e: 1.x session `GET /proxy/<SESSION_ID>/file/content?path=<a file in /project>` → 403 and `GET .../api/fs/read/<file>` → 403; `GET .../file?path=` (listing) → 200. 2.x session `GET /proxy/<SESSION_ID_V2>/api/fs/read/<file>` → 400 FeatureDisabled "file downloads are disabled"; `GET .../api/fs/list` → 200. (Find a file that exists in `/project` on both dev machines, e.g. `opencode.json`.)
- [ ] UI e2e (both builds): `mod+p` opens no file picker / `/open` offers nothing; the "+"/Open tab entry is absent (mirror the existing terminal/uploads UI tests, with positive controls).
- [ ] Make sure no existing e2e test relied on reading file contents (search for `file/content`, `fs/read`, file tabs); adapt only if needed, without weakening intent.
- [ ] README "Deployment Config": `downloads` for 1.x and 2.x: what it blocks (file contents through opencode-rc: the file viewer, opening files, 2.x chat links to paths and images loaded from disk, the diff's full-file context), what stays (chat, diffs, `@` mentions, listing), and that it can't stop the AI from printing a file into the chat; with `uploads` also disabled, nothing is transferred to or from the machine through opencode-rc except chat text and diff hunks.
- [ ] `cd e2e && npx tsc --noEmit -p tsconfig.json`. Commit — `test(e2e): downloads disabled on both versions` and `docs: the downloads toggle`.

## After the tasks (controller)

- Full e2e on kind; fix loop on failures; final review; then report to the user.
