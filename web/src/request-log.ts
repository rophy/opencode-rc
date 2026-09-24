import type { MiddlewareHandler } from "hono";
import { logger } from "hono/logger";

// hono's logger prints the path with its query; WebSocket clients send the
// access token as ?access_token=, which must not end up in logs.
export function redactAccessToken(line: string): string {
  return line.replace(/([?&]access_token=)[^&#\s]*/gi, "$1<redacted>");
}

export function requestLogger(
  print: (line: string) => void = console.log,
): MiddlewareHandler {
  return logger((line, ...rest) => print([redactAccessToken(line), ...rest].join(" ")));
}
