import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { originOf, makeOriginCheck, validateReturnTo, corsMiddleware, APP_CALLBACK } from "./origins.js";

const isAllowed = makeOriginCheck("https://rc.example.com", ["https://dev.example.com/"]);

describe("originOf", () => {
  it("handles http(s) and capacitor URLs", () => {
    expect(originOf("https://rc.example.com/a?b#c")).toBe("https://rc.example.com");
    expect(originOf("http://localhost:5173/")).toBe("http://localhost:5173");
    expect(originOf("capacitor://localhost/s/x/")).toBe("capacitor://localhost");
  });

  it("returns null for junk", () => {
    expect(originOf("not a url")).toBeNull();
  });
});

describe("makeOriginCheck", () => {
  it("allows server, app and extra origins", () => {
    expect(isAllowed("https://rc.example.com")).toBe(true);
    expect(isAllowed("capacitor://localhost")).toBe(true);
    expect(isAllowed("https://localhost")).toBe(true);
    expect(isAllowed("https://dev.example.com")).toBe(true);
  });

  it("rejects others", () => {
    expect(isAllowed("https://evil.example.com")).toBe(false);
    expect(isAllowed("")).toBe(false);
    expect(isAllowed(undefined)).toBe(false);
  });
});

describe("validateReturnTo", () => {
  it("defaults to /", () => {
    expect(validateReturnTo(undefined, isAllowed)).toBe("/");
    expect(validateReturnTo("", isAllowed)).toBe("/");
  });

  it("accepts same-origin paths and strips the fragment", () => {
    expect(validateReturnTo("/s/abc/?x=1#old", isAllowed)).toBe("/s/abc/?x=1");
  });

  it("rejects protocol-relative and backslash paths", () => {
    expect(validateReturnTo("//evil.example.com/", isAllowed)).toBeNull();
    expect(validateReturnTo("/\\evil.example.com/", isAllowed)).toBeNull();
  });

  it("rejects control characters and backslashes anywhere", () => {
    expect(validateReturnTo("/\t/evil.com", isAllowed)).toBeNull();
    expect(validateReturnTo("/\n/evil.com", isAllowed)).toBeNull();
    expect(validateReturnTo("/\r/evil.com", isAllowed)).toBeNull();
    expect(validateReturnTo("/\\evil.com", isAllowed)).toBeNull();
    expect(validateReturnTo("/x\\y", isAllowed)).toBeNull();
    expect(validateReturnTo("/x\x7fy", isAllowed)).toBeNull();
    expect(validateReturnTo("https://localhost/\t/x", isAllowed)).toBeNull();
    expect(validateReturnTo("https://localhost\\@evil.com/", isAllowed)).toBeNull();
  });

  it("allows percent-encoded control characters in paths", () => {
    expect(validateReturnTo("/%09/foo", isAllowed)).toBe("/%09/foo");
  });

  it("rejects paths that normalize to a protocol-relative URL", () => {
    expect(validateReturnTo("/.//evil.com", isAllowed)).toBeNull();
    expect(validateReturnTo("/a/..//evil.com/x", isAllowed)).toBeNull();
    expect(validateReturnTo("/./", isAllowed)).toBe("/");
  });

  it("returns the normalized path", () => {
    expect(validateReturnTo("/a/../b?x=1", isAllowed)).toBe("/b?x=1");
  });

  it("accepts allowed absolute URLs", () => {
    expect(validateReturnTo("https://dev.example.com/", isAllowed)).toBe("https://dev.example.com/");
    expect(validateReturnTo("https://dev.example.com/s/x/#y", isAllowed)).toBe("https://dev.example.com/s/x/");
  });

  it("rejects other absolute URLs", () => {
    expect(validateReturnTo("https://evil.example.com/", isAllowed)).toBeNull();
    expect(validateReturnTo("javascript:alert(1)", isAllowed)).toBeNull();
  });

  it("accepts exactly the mobile app callback", () => {
    expect(APP_CALLBACK).toBe("com.opencode.rc:/auth/done");
    expect(validateReturnTo("com.opencode.rc:/auth/done", isAllowed)).toBe("com.opencode.rc:/auth/done");
    for (const bad of [
      "com.opencode.rc:/auth/done/x",
      "com.opencode.rc:/auth/done?x=1",
      "com.opencode.rc:/auth/done#x",
      "com.opencode.rc://auth/done",
      "com.opencode.rcx:/auth/done",
      "COM.OPENCODE.RC:/auth/done",
      "other.app:/auth/done",
    ]) {
      expect(validateReturnTo(bad, isAllowed)).toBeNull();
    }
  });

  it("returns the app callback unchanged, not normalized as a path", () => {
    expect(validateReturnTo(APP_CALLBACK, isAllowed)).toBe(APP_CALLBACK);
  });

  it("treats a path-looking variant of the app callback as a normal same-origin path", () => {
    expect(validateReturnTo("/com.opencode.rc:/auth/done", isAllowed)).toBe("/com.opencode.rc:/auth/done");
  });

  it("no longer accepts the app's WebView origins as return_to", () => {
    expect(validateReturnTo("capacitor://localhost/", isAllowed)).toBeNull();
    expect(validateReturnTo("https://localhost/s/x/", isAllowed)).toBeNull();
    // They stay allowed for CORS.
    expect(isAllowed("capacitor://localhost")).toBe(true);
    expect(isAllowed("https://localhost")).toBe(true);
  });
});

describe("corsMiddleware", () => {
  const app = new Hono();
  app.use("*", corsMiddleware((o) => isAllowed(o)));
  app.get("/x", (c) => c.text("ok"));

  it("answers preflight for allowed origins", async () => {
    const res = await app.request("/x", {
      method: "OPTIONS",
      headers: {
        origin: "capacitor://localhost",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,x-opencode-directory",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("sets allow-origin on normal responses", async () => {
    const res = await app.request("/x", { headers: { origin: "https://localhost" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://localhost");
  });

  it("omits allow-origin for other origins", async () => {
    const res = await app.request("/x", { headers: { origin: "https://evil.example.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("exposes the protocol header to browser code", async () => {
    const res = await app.request("/x", { headers: { origin: "https://localhost" } });
    expect(res.headers.get("access-control-expose-headers")).toContain("OpenCode-RC-Protocol");
  });
});
