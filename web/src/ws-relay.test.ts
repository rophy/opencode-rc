import { describe, it, expect } from "vitest";
import { relayCloseCode } from "./ws-close.js";

describe("relayCloseCode", () => {
  it("passes through normal codes", () => {
    expect(relayCloseCode(1000)).toBe(1000);
    expect(relayCloseCode(1001)).toBe(1001);
    expect(relayCloseCode(4001)).toBe(4001);
  });

  it("maps codes that cannot be sent", () => {
    expect(relayCloseCode(1005)).toBe(1000);
    expect(relayCloseCode(1006)).toBe(1011);
    expect(relayCloseCode(1015)).toBe(1011);
  });
});
