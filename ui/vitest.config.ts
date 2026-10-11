import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"
import { parseConfig } from "../config/schema.ts"

export default defineConfig({
  plugins: [solid()],
  define: {
    __RC_CONFIG__: JSON.stringify(parseConfig({})),
  },
  test: {
    environment: "jsdom",
  },
})
