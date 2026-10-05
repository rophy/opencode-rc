// The deployment config (config.json), shared by the UI build (ui/vite.config.ts) and the
// API (api/src/rc-config.ts). Keep it free of dependencies: both import it directly.

// Every feature that can be switched off. A disabled feature gets the UI build's patches in
// vendor/patches/<name>/ and the API's runtime guard in api/src/feature-guards.ts.
export const FEATURES = ["uploads", "terminal", "shell", "export", "share"] as const;

export type FeatureName = (typeof FEATURES)[number];

export interface RcConfig {
  /** API URL compiled into the UI. The API ignores it. */
  serverUrl?: string;
  features: Record<FeatureName, { enabled: boolean }>;
}

export class ConfigError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Unknown keys are errors at every level, so a typo cannot leave a feature on.
export function parseConfig(raw: unknown, source = "config"): RcConfig {
  const fail = (message: string): never => {
    throw new ConfigError(`${source}: ${message}`);
  };
  const only = (value: Record<string, unknown>, allowed: string[], prefix: string) => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail(`unknown key "${prefix}${key}"`);
    }
  };
  const feature = (value: unknown, name: string): { enabled: boolean } => {
    if (value === undefined) return { enabled: true };
    if (!isObject(value)) return fail(`${name} must be an object`);
    only(value, ["enabled"], `${name}.`);
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
      fail(`${name}.enabled must be true or false`);
    }
    return { enabled: value.enabled !== false };
  };

  if (!isObject(raw)) return fail("must be a JSON object");
  only(raw, ["serverUrl", "features"], "");

  let serverUrl: string | undefined;
  if (raw.serverUrl !== undefined) {
    if (typeof raw.serverUrl !== "string") return fail("serverUrl must be a string");
    let url: URL;
    try {
      url = new URL(raw.serverUrl);
    } catch {
      return fail("serverUrl is not a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") fail("serverUrl must start with http:// or https://");
    if (url.search || url.hash) fail("serverUrl must not have a query or fragment");
    serverUrl = url.href.replace(/\/+$/, "");
  }

  const features = raw.features ?? {};
  if (!isObject(features)) return fail("features must be an object");
  only(features, [...FEATURES], "features.");

  return {
    ...(serverUrl ? { serverUrl } : {}),
    features: Object.fromEntries(FEATURES.map((name) => [name, feature(features[name], `features.${name}`)])) as RcConfig["features"],
  };
}

export function parseConfigText(text: string, source = "config"): RcConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${source}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return parseConfig(raw, source);
}
