import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { notFoundJson } from "./not-found.js";

describe("notFoundJson", () => {
  const app = new Hono();
  app.get("/api/me", (c) => c.json({ ok: true }));
  app.notFound(notFoundJson());

  it("answers every unknown path with a JSON 404, never HTML", async () => {
    for (const path of ["/", "/index.html", "/s/alice-dev/", "/s/alice-dev/abc/session/ses_1", "/assets/app.js", "/api/nope"]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "not found" });
    }
  });

  it("leaves known routes alone", async () => {
    const res = await app.request("/api/me");
    expect(res.status).toBe(200);
  });
});
