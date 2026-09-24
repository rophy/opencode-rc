import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { redactAccessToken, requestLogger } from "./request-log.js";

describe("redactAccessToken", () => {
  it("redacts the access_token query value", () => {
    expect(redactAccessToken("<-- GET /proxy/x/pty/1/connect?access_token=abc.def")).toBe(
      "<-- GET /proxy/x/pty/1/connect?access_token=<redacted>",
    );
    expect(redactAccessToken("--> GET /p?a=1&access_token=abc.def&b=2 101 3ms")).toBe(
      "--> GET /p?a=1&access_token=<redacted>&b=2 101 3ms",
    );
  });

  it("leaves other lines alone", () => {
    expect(redactAccessToken("<-- GET /api/me?x_access_token=1")).toBe("<-- GET /api/me?x_access_token=1");
    expect(redactAccessToken("<-- POST /auth/token")).toBe("<-- POST /auth/token");
  });
});

describe("requestLogger", () => {
  it("never logs the token", async () => {
    const lines: string[] = [];
    const app = new Hono();
    app.use("*", requestLogger((l) => lines.push(l)));
    app.get("/p", (c) => c.text("ok"));
    await app.request("/p?cursor=1&access_token=secret-token");
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).not.toContain("secret-token");
      expect(l).toContain("/p?cursor=1&access_token=<redacted>");
    }
  });
});
