import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const parts = (v: string) => v.split(".").map(Number);
const cmp = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

describe("config/opencode-versions.json", () => {
  it("accepts the pinned vendor/opencode-v2 (min <= version < max)", () => {
    const { v2 } = read("../../config/opencode-versions.json");
    const pinned = read("../../vendor/opencode-v2/packages/app/package.json").version as string;
    expect(v2).toBeTruthy();
    expect(cmp(pinned, v2.min)).toBeGreaterThanOrEqual(0);
    expect(cmp(pinned, v2.max)).toBeLessThan(0);
  });
});
