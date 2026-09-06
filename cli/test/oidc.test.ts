import { describe, it, expect } from "vitest";

describe("oidc", () => {
  it("should export deviceFlowAuth", async () => {
    const { deviceFlowAuth } = await import("../src/oidc.js");
    expect(typeof deviceFlowAuth).toBe("function");
  });
});
