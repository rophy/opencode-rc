// The deployment config (config.json), shared by the UI build (ui/vite.config.ts) and the
// API (api/src/rc-config.ts). Keep it free of dependencies: both import it directly.
// Feature toggles for opencode 1.x live under `features`, those for 2.x under `opencodeV2.features`.

// downloads blocks reading a file's contents (not listing or finding files).
// Every feature that can be switched off. A disabled feature gets the UI build's patches in
// vendor/patches/v1/<name>/ and the API's runtime guard in api/src/feature-guards.ts.
export const FEATURES = ["uploads", "downloads", "terminal", "shell", "export", "share"] as const;

export type FeatureName = (typeof FEATURES)[number];

// The 2.x feature toggles. A disabled feature gets the 2.x UI patches in
// vendor/patches/v2/<name>/ (step 4) and the API's v2 rules in api/src/v2-guard.ts.
export const FEATURES_V2 = ["uploads", "downloads", "terminal", "shell", "export"] as const;

export type FeatureNameV2 = (typeof FEATURES_V2)[number];

export interface RcConfig {
  /** API URL compiled into the UI. The API ignores it. */
  serverUrl?: string;
  features: Record<FeatureName, { enabled: boolean }>;
  opencodeV2: {
    features: Record<FeatureNameV2, { enabled: boolean }>;
    /** Narrows the opencode 2.x versions the server accepts (min <= v < max). The gateway reads it. */
    versions?: { min: string; max: string };
  };
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
  only(raw, ["serverUrl", "features", "opencodeV2"], "");

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

  const v2 = raw.opencodeV2 ?? {};
  if (!isObject(v2)) return fail("opencodeV2 must be an object");
  only(v2, ["features", "versions"], "opencodeV2.");
  let versions: { min: string; max: string } | undefined;
  if (v2.versions !== undefined) {
    if (!isObject(v2.versions)) return fail("opencodeV2.versions must be an object");
    only(v2.versions, ["min", "max"], "opencodeV2.versions.");
    const semver = /^\d+\.\d+\.\d+$/;
    const { min, max } = v2.versions;
    if (typeof min !== "string" || !semver.test(min)) return fail("opencodeV2.versions.min must be a MAJOR.MINOR.PATCH version");
    if (typeof max !== "string" || !semver.test(max)) return fail("opencodeV2.versions.max must be a MAJOR.MINOR.PATCH version");
    const [a, b] = [min.split(".").map(Number), max.split(".").map(Number)];
    const order = a.findIndex((n, i) => n !== b[i]);
    if (order === -1 || a[order] > b[order]) return fail("opencodeV2.versions.min must be lower than max");
    versions = { min, max };
  }
  const v2Features = v2.features ?? {};
  if (!isObject(v2Features)) return fail("opencodeV2.features must be an object");
  only(v2Features, [...FEATURES_V2], "opencodeV2.features.");

  return {
    ...(serverUrl ? { serverUrl } : {}),
    features: Object.fromEntries(FEATURES.map((name) => [name, feature(features[name], `features.${name}`)])) as RcConfig["features"],
    opencodeV2: {
      features: Object.fromEntries(
        FEATURES_V2.map((name) => [name, feature(v2Features[name], `opencodeV2.features.${name}`)]),
      ) as RcConfig["opencodeV2"]["features"],
      ...(versions ? { versions } : {}),
    },
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
