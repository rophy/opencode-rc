import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { protocolRoutes } from "./opencode-routes.testutil.js";

const v1 = fileURLToPath(new URL("../../vendor/opencode-v1", import.meta.url));
const v2 = fileURLToPath(new URL("../../vendor/opencode-v2", import.meta.url));

describe("protocolRoutes", () => {
  it("reads every opencode 2.0.26 operation", () => {
    const routes = protocolRoutes(v2);
    expect(routes).toHaveLength(142);
    expect(routes).toContainEqual({ method: "POST", path: "/api/session/:sessionID/prompt" });
    // Paths built from a `const root = "/api/worktree"` and `${root}/refresh`
    expect(routes).toContainEqual({ method: "POST", path: "/api/worktree" });
    expect(routes).toContainEqual({ method: "POST", path: "/api/worktree/refresh" });
    expect(routes).toContainEqual({ method: "PATCH", path: "/api/project/:projectID" });
    // Endpoints whose call spans several lines
    expect(routes).toContainEqual({ method: "POST", path: "/api/integration/:integrationID/connect/external" });
  });

  it("reads opencode 1.18's /api operations", () => {
    const api = protocolRoutes(v1).filter((r) => r.path.startsWith("/api/"));
    expect(api).toHaveLength(58);
    expect(api).toContainEqual({ method: "POST", path: "/api/pty" });
  });
});
