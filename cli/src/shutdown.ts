export interface Closable {
  close(): void;
}

export interface ShutdownDeps {
  getServer(): Closable | undefined;
  getTunnel(): Closable | undefined;
  exit(code: number): void;
}

/**
 * One shutdown path for every phase (opencode starting, tunnel connecting, running).
 * Registering a SIGINT listener removes Node's default exit, so the handler must exit itself.
 * Ctrl+C signals the whole process group, so the child may exit first: `isShuttingDown`
 * lets the child-exit handler stay quiet.
 */
export function createShutdown(deps: ShutdownDeps) {
  let shuttingDown = false;
  return {
    isShuttingDown: () => shuttingDown,
    shutdown() {
      shuttingDown = true;
      console.log("\nShutting down...");
      deps.getTunnel()?.close();
      deps.getServer()?.close();
      deps.exit(0);
    },
  };
}
