// Compatibility with the gateway's tunnel, independent of release versions
// (docs/api-versioning.md). Raise MIN_GATEWAY_PROTOCOL when the CLI relies on newer
// gateway behaviour; bump PROTOCOL when the gateway needs to tell this CLI apart.
export const PROTOCOL_HEADER = "OpenCode-RC-Protocol";
export const PROTOCOL = 1;
export const MIN_GATEWAY_PROTOCOL = 1;

export function readProtocol(value: string | null | undefined): number {
  return value && /^\d+$/.test(value) ? Number(value) : 0;
}

/** A client/server version mismatch: fatal, never retried. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}
