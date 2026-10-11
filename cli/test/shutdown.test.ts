import { describe, it, expect, vi } from "vitest";
import { createShutdown } from "../src/shutdown.js";

function setup(opts: { server?: boolean; tunnel?: boolean }) {
  const server = { close: vi.fn() };
  const tunnel = { close: vi.fn() };
  const exit = vi.fn();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const s = createShutdown({
    getServer: () => (opts.server ? server : undefined),
    getTunnel: () => (opts.tunnel ? tunnel : undefined),
    exit,
  });
  return { s, server, tunnel, exit };
}

describe("createShutdown", () => {
  it("before the tunnel exists, closes the server and exits 0", () => {
    const { s, server, tunnel, exit } = setup({ server: true });
    s.shutdown();
    expect(server.close).toHaveBeenCalled();
    expect(tunnel.close).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits 0 even before the server exists", () => {
    const { s, exit } = setup({});
    s.shutdown();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("after the tunnel exists, closes both", () => {
    const { s, server, tunnel, exit } = setup({ server: true, tunnel: true });
    s.shutdown();
    expect(server.close).toHaveBeenCalled();
    expect(tunnel.close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("reports shutting down only once shutdown started", () => {
    const { s } = setup({});
    expect(s.isShuttingDown()).toBe(false);
    s.shutdown();
    expect(s.isShuttingDown()).toBe(true);
  });
});
