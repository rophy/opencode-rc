import type { NotFoundHandler } from "hono";

// The API host serves no HTML: anything that is not an API route is a JSON 404.
export function notFoundJson(): NotFoundHandler {
  return (c) => c.json({ error: "not found" }, 404);
}
