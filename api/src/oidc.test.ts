import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "http";
import { discoverOIDC, createProvider, verifyToken } from "./oidc.js";

function startMockOIDC(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        const host = req.headers.host;
        const issuer = `http://${host}`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve({ server, url: `http://127.0.0.1:${addr.port}` });
      }
    });
  });
}

let mockServer: Server | undefined;
let mockUrl: string;

describe("discoverOIDC", () => {
  afterAll(() => {
    mockServer?.close();
  });

  async function getMock() {
    if (!mockServer) {
      const m = await startMockOIDC();
      mockServer = m.server;
      mockUrl = m.url;
    }
    return mockUrl;
  }

  it("returns discovery endpoints without overrides", async () => {
    const url = await getMock();
    const discovery = await discoverOIDC(url, undefined, 1);
    expect(discovery.issuer).toBe(url);
    expect(discovery.authorization_endpoint).toBe(`${url}/authorize`);
    expect(discovery.token_endpoint).toBe(`${url}/token`);
    expect(discovery.jwks_uri).toBe(`${url}/jwks`);
  });

  it("applies issuer override", async () => {
    const url = await getMock();
    const discovery = await discoverOIDC(
      url,
      { issuer: "https://external.example.com" },
      1,
    );
    expect(discovery.issuer).toBe("https://external.example.com");
    expect(discovery.authorization_endpoint).toBe(`${url}/authorize`);
  });

  it("applies authorization_endpoint override", async () => {
    const url = await getMock();
    const discovery = await discoverOIDC(
      url,
      { authorization_endpoint: "https://external.example.com/authorize" },
      1,
    );
    expect(discovery.authorization_endpoint).toBe(
      "https://external.example.com/authorize",
    );
    expect(discovery.token_endpoint).toBe(`${url}/token`);
  });

  it("applies token_endpoint override", async () => {
    const url = await getMock();
    const discovery = await discoverOIDC(
      url,
      { token_endpoint: "https://internal.example.com/token" },
      1,
    );
    expect(discovery.token_endpoint).toBe(
      "https://internal.example.com/token",
    );
    expect(discovery.authorization_endpoint).toBe(`${url}/authorize`);
  });

  it("applies jwks_uri override", async () => {
    const url = await getMock();
    const discovery = await discoverOIDC(
      url,
      { jwks_uri: "https://internal.example.com/jwks" },
      1,
    );
    expect(discovery.jwks_uri).toBe("https://internal.example.com/jwks");
  });

  it("applies all overrides together", async () => {
    const url = await getMock();
    const discovery = await discoverOIDC(
      url,
      {
        issuer: "https://ext.example.com",
        authorization_endpoint: "https://ext.example.com/authorize",
        token_endpoint: "https://int.example.com/token",
        jwks_uri: "https://int.example.com/jwks",
      },
      1,
    );
    expect(discovery.issuer).toBe("https://ext.example.com");
    expect(discovery.authorization_endpoint).toBe(
      "https://ext.example.com/authorize",
    );
    expect(discovery.token_endpoint).toBe("https://int.example.com/token");
    expect(discovery.jwks_uri).toBe("https://int.example.com/jwks");
  });

  it("ignores empty override values", async () => {
    const url = await getMock();
    const discovery = await discoverOIDC(
      url,
      {
        issuer: "",
        authorization_endpoint: "",
        token_endpoint: "",
        jwks_uri: "",
      },
      1,
    );
    expect(discovery.issuer).toBe(url);
    expect(discovery.authorization_endpoint).toBe(`${url}/authorize`);
    expect(discovery.token_endpoint).toBe(`${url}/token`);
    expect(discovery.jwks_uri).toBe(`${url}/jwks`);
  });

  it("throws after max retries for unreachable issuer", async () => {
    await expect(
      discoverOIDC("http://127.0.0.1:1", undefined, 1),
    ).rejects.toThrow("OIDC discovery failed after 1 attempts");
  });

  it("throws for non-ok response", async () => {
    const server = createServer((req, res) => {
      res.writeHead(500);
      res.end("internal error");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      await expect(
        discoverOIDC(`http://127.0.0.1:${port}`, undefined, 1),
      ).rejects.toThrow("OIDC discovery: 500");
    } finally {
      server.close();
    }
  });
});

describe("createProvider", () => {
  it("creates a provider with discovery and jwks", () => {
    const discovery = {
      issuer: "https://idp.example.com",
      authorization_endpoint: "https://idp.example.com/authorize",
      token_endpoint: "https://idp.example.com/token",
      jwks_uri: "https://idp.example.com/jwks",
    };
    const provider = createProvider(discovery);
    expect(provider.discovery).toBe(discovery);
    expect(provider.jwks).toBeDefined();
  });
});

describe("verifyToken", () => {
  it("rejects an invalid token", async () => {
    const discovery = {
      issuer: "https://idp.example.com",
      authorization_endpoint: "https://idp.example.com/authorize",
      token_endpoint: "https://idp.example.com/token",
      jwks_uri: "https://idp.example.com/jwks",
    };
    const provider = createProvider(discovery);
    await expect(
      verifyToken(provider, "not-a-real-jwt", "test-audience"),
    ).rejects.toThrow();
  });
});
