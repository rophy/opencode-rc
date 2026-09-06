import { describe, it, expect } from "vitest";

describe("oidc", () => {
  it("should export authorizationCodeAuth", async () => {
    const { authorizationCodeAuth } = await import("../src/oidc.js");
    expect(typeof authorizationCodeAuth).toBe("function");
  });
});
