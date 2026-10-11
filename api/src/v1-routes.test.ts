import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { protocolRoutes } from "./opencode-routes.testutil.js";
import { V1_API_ROUTES } from "./v1-routes.js";
import { V2_ROUTES } from "./v2-routes.js";

const v1 = fileURLToPath(new URL("../../vendor/opencode-v1", import.meta.url));
const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe("V1_API_ROUTES", () => {
  it("is exactly opencode 1.x's /api routes (update it when bumping vendor/opencode-v1)", () => {
    const source = protocolRoutes(v1).filter((r) => r.path.startsWith("/api/")).map(key).sort();
    const table = V1_API_ROUTES.map(([method, path]) => key({ method, path })).sort();
    expect(table).toEqual(source);
  });
});

describe("2.x routes outside /api", () => {
  // v1ApiGuard refuses these on 1.x sessions. A new one needs a look at whether a legacy
  // 1.x path matches it.
  it("are exactly GET /auth/connect/:code", () => {
    const nonApi = V2_ROUTES.filter(([, path]) => !path.startsWith("/api/")).map(([m, p]) => `${m} ${p}`);
    expect(nonApi).toEqual(["GET /auth/connect/:code"]);
  });
});
