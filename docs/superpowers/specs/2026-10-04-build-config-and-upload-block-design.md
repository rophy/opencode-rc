# Build-Time Config and Upload Block

Date: 2026-10-04
Status: Approved design

## Problem

Corporate deployments need to switch off parts of the opencode web UI, starting with file
uploads (images and any other file type). The UI ships mainly as mobile apps, plus a web image
used mostly for testing. Today:

- The UI learns its server from a runtime `/config.json` (`{"serverUrl": …}`), written by the
  web image at container start from `API_URL`, or copied into `dist/` before `cap sync` for
  mobile. There is no way to turn features off.
- The API is configured by env vars only and forwards every request body to opencode
  untouched (`api/src/proxy.ts`).
- opencode's app has no setting that disables attachments. Leaving the `Platform` upload hooks
  out only makes it fall back to the browser's file input, paste and drop.

## Goals

- Admins maintain one `config.json` per deployment.
- The UI build (web and mobile) reads it: `serverUrl` is compiled in, and disabled features are
  removed from the bundle, not hidden.
- The API reads the same file at runtime and enforces the feature flags. The API is the
  security boundary; removing code from the UI protects against operator error (API flag left
  on) and keeps upstream upload code out of the bundle.
- First feature: `uploads`.

## Non-goals

- Moving the API's existing env vars (`OIDC_*`, `REDIS_URL`, …) into the file.
- Blocking content pasted into the terminal (PTY). Request filtering cannot see it; documented
  as a known gap.
- Restricting `file://` @mention paths (opencode reads them with `bypassCwdCheck`). Separate
  concern.
- Version bumps.

## Config file

```json
{
  "serverUrl": "https://rc-api.example.com",
  "features": {
    "uploads": { "enabled": false }
  }
}
```

- Every key is optional. A missing feature is enabled.
- Unknown keys (top level, under `features`, or inside a feature) are errors, so a typo cannot
  leave a feature on. `serverUrl` must be an `http(s)` URL; a trailing slash is stripped.
- One schema module, `config/schema.ts` at the repo root, parses and validates the file. Both
  `ui/vite.config.ts` and `api/` import it, and both Dockerfiles copy `config/`. It has no
  dependencies.
- Each feature is an object so later features can carry options.

## UI build

- `OPENCODE_RC_CONFIG=<path>` selects the file for `bun run build` (and `bun run dev`). Unset
  means no file: no preset server, all features enabled. A file that fails validation fails the
  build.
- The parsed config is exposed to `ui/src` as a compile-time constant (Vite `define`), so code
  for a disabled feature is dead and dropped.
- **serverUrl.** `ui/src/server.ts` takes the preset from the constant. `loadConfig()` and the
  runtime fetch of `/config.json` are removed. With a preset the config screen is skipped (the
  existing `isPreConfigured()` path); without one the user enters the server as today.
- **CSP.** The build's CSP meta tag narrows `connect-src` to the `serverUrl` origin (http(s)
  and ws(s)) when one is set; otherwise it stays as today.
- **Feature rewrites.** A Vite `enforce: "pre"` transform plugin (same pattern as
  `opencodeAppFonts`) rewrites specific upstream files when a feature is disabled. Each rewrite
  is an exact search/replace; if a search string is not found the build fails, so an opencode
  bump cannot silently bring a feature back.

### `uploads` rewrites (opencode v1.18.29)

All paths under `vendor/opencode/packages/`.

| Surface | File | Change |
| --- | --- | --- |
| v1 composer | `app/src/components/prompt-input.tsx` | remove attach button, both hidden `<input type="file">`, the `file.attach` command (`mod+u`) |
| v1 paste/drop | `app/src/components/prompt-input/attachments.ts` | paste and drop ignore files; `file:` drops (@mentions) still work |
| v2 composer | `app/src/components/prompt-input-v2.tsx` | omit the `attachments:` config (disables attach, paste, drop in `session-ui` interaction) and the `file.attach` command |
| v2 controls | `session-ui/src/v2/components/prompt-input/index.tsx` | remove hidden file input and the "+" menu Attachments item |
| Project icon | `app/src/components/dialog-edit-project.tsx`, `dialog-edit-project-v2.tsx` | remove icon file input and drop zone |

The exact search strings are settled in the implementation plan against the pinned tag.
@mentions (`file://` references to workspace files) are not uploads and keep working.

## Web image

- `ui/web/Dockerfile` takes the config as a build input (build arg naming a path in the
  context; no file means a generic build).
- Removed: `ui/web/40-rc-config.sh`, the `API_URL` env var, nginx's `location = /config.json`.
- nginx security headers are generated at build time: `connect-src` is `'self'` plus the
  `serverUrl` origin when set, otherwise the wide form used by the meta tag.
- The published image is a generic build: users enter the server.

## API

- `OPENCODE_RC_CONFIG=<path>` selects the file, read once at startup with the shared schema.
  Unset means all features enabled. An invalid file stops startup. The API ignores `serverUrl`.
- New `api/src/upload-guard.ts`, a middleware placed before `proxyHttp()` on
  `/proxy/:sessionId/*`, active only when uploads are disabled:

| Request (path after `/proxy/:sessionId`) | Rejected when |
| --- | --- |
| `POST /session/:id/message`, `/prompt_async`, `/command` | any `parts[]` item with `type: "file"` whose `url` does not start with `file:`, unless `source.type === "resource"` (MCP) |
| `PATCH /session/:id/message/:mid/part/:pid` | the body is such a file part |
| `POST /api/session/:id/prompt` (v2 API) | any `prompt.files[].uri` that does not start with `file:` |
| `PATCH /project/:id` | `icon.override` starts with `data:` |

- Rejections return 403 with a short text body. A matched request whose body is not valid JSON
  returns 400.
- Matched requests are buffered (`arrayBuffer()`), checked, and the same bytes are forwarded.
  The UI already buffers request bodies (`ui/src/proxy-fetch.ts`), so behaviour is unchanged.
  Unmatched requests stream as today.
- `http(s):` file URLs are rejected too: opencode passes them to the model as attachments.

## Chart

- New `config:` values block (default `{}`), rendered with `toJson` into a ConfigMap, mounted
  into the api pod, `OPENCODE_RC_CONFIG` pointing at it.
- The `ui` deployment drops its `API_URL` env. Admins set `ui.image` to their own build made
  from the same file. With the default image, users enter the API URL in the UI.

## Mobile docs

`docs/ios-app.md` (the only mobile doc; Android has none) replaces "write `dist/config.json` before
`npx cap sync`" with `OPENCODE_RC_CONFIG=/path/to/config.json bun run build`. `AGENTS.md` is
updated to match.

## Testing

- **Schema:** valid files, unknown keys, bad `serverUrl`, empty file.
- **Upload guard (unit):** each rejected shape returns 403; text-only prompts, `file://`
  @mentions, MCP resource parts and unrelated endpoints pass; invalid JSON returns 400; the
  forwarded body equals the original bytes.
- **UI build:** a build with `uploads` disabled applies every rewrite (plugin unit test with a
  missing search string fails); `server.ts` tests cover preset vs. user-entered server.
- **e2e:** the UI image is built from an e2e `config.json` (e2e API URL, uploads disabled) and
  the API gets the same file through `config:`. Tests: a hand-built `data:` prompt gets 403, a
  text prompt still works, the attach button is absent. The `/config.json` test in
  `e2e/e2e.test.ts` and `ui/web/smoke-test.sh` are updated for the removed runtime file.

## Upgrade impact

Chart users relying on `API_URL` see the generic UI ask for the server URL until they build
their own UI image. Covered by a short note in release comms.
