import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { protocolRoutes } from "./opencode-routes.testutil.js";
import { V2_ROUTES } from "./v2-routes.js";

const v2 = fileURLToPath(new URL("../../vendor/opencode-v2", import.meta.url));
const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe("V2_ROUTES", () => {
  it("classifies exactly opencode 2.x's routes (update it when bumping vendor/opencode-v2)", () => {
    const source = protocolRoutes(v2).map(key).sort();
    const table = V2_ROUTES.map(([method, path]) => key({ method, path })).sort();
    expect(table).toEqual(source);
  });

  it("lists each route once", () => {
    const keys = V2_ROUTES.map(([method, path]) => `${method} ${path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
