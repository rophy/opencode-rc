// 1005 (no status), 1006 (abnormal) and 1015 (TLS) are reserved: they can be
// received but must not be sent in a close frame.
export function relayCloseCode(code: number): number {
  if (code === 1005) return 1000;
  if (code === 1006 || code === 1015) return 1011;
  return code;
}

// A close frame's reason is at most 123 bytes of UTF-8.
export function closeReason(reason: string): string {
  const bytes = new TextEncoder().encode(reason);
  if (bytes.length <= 123) return reason;
  return new TextDecoder().decode(bytes.slice(0, 123)).replace(/\uFFFD$/, "");
}
