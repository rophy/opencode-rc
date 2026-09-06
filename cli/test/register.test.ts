// cli/test/register.test.ts
import { describe, it, expect } from "vitest";
import { generateSessionID } from "../src/register.js";

describe("register", () => {
  it("generates a session ID with hostname prefix", () => {
    const id = generateSessionID();
    expect(id).toMatch(/^.+-[a-f0-9]{8}$/);
  });

  it("generates unique session IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionID()));
    expect(ids.size).toBe(100);
  });
});
