import type { RcConfig } from "../../config/schema"

declare const __RC_CONFIG__: RcConfig

// The deployment config the UI was built with (OPENCODE_RC_CONFIG, see vite.config.ts).
// Tests get the default config from vitest.config.ts.
export const buildConfig: RcConfig = __RC_CONFIG__
