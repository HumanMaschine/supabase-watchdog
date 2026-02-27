import { parse as parseYaml } from "@std/yaml";
import type { WatchdogConfig } from "./types.ts";

const ENV_VAR_PATTERN = /^\$\{([^}]+)\}$/;

const DEFAULTS = {
  polling: {
    interval: "5m",
    sources: [
      "edge_logs",
      "auth_logs",
      "postgres_logs",
      "storage_logs",
      "realtime_logs",
      "postgrest_logs",
    ],
  },
  filters: {
    min_status_code: 500,
    ignore_patterns: [] as string[],
    max_alerts_per_interval: 20,
  },
};

/**
 * Parse a duration string into milliseconds.
 * Supported units: s (seconds), m (minutes), h (hours).
 * Supports compound durations like "2h30m".
 *
 * By default enforces a minimum of 60,000ms (1 minute).
 * Pass `{ noMinimum: true }` to allow any positive duration.
 */
export function parseDuration(
  input: string,
  options?: { noMinimum?: boolean },
): number {
  const pattern = /(\d+)(h|m|s)/g;
  let total = 0;
  let matched = false;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    matched = true;
    const value = parseInt(match[1]!, 10);
    const unit = match[2]!;
    switch (unit) {
      case "h":
        total += value * 3_600_000;
        break;
      case "m":
        total += value * 60_000;
        break;
      case "s":
        total += value * 1_000;
        break;
    }
  }

  if (!matched) {
    throw new Error(`"${input}" is not a valid duration`);
  }

  if (!options?.noMinimum && total < 60_000) {
    throw new Error(
      `duration "${input}" is below minimum (1 minute)`,
    );
  }

  return total;
}

/**
 * Recursively walk a parsed YAML value and replace full-string "${VAR}"
 * patterns with the corresponding environment variable value.
 * Tracks the current config path for error messages.
 */
function interpolateEnv(
  value: unknown,
  path: string,
  errors: string[],
): unknown {
  if (typeof value === "string") {
    const match = ENV_VAR_PATTERN.exec(value);
    if (match) {
      const varName = match[1]!;
      const envValue = Deno.env.get(varName);
      if (!envValue) {
        errors.push(
          `environment variable "${varName}" is not set (referenced in ${path})`,
        );
        return value;
      }
      return envValue;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => interpolateEnv(item, `${path}[${i}]`, errors));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = interpolateEnv(val, path ? `${path}.${key}` : key, errors);
    }
    return result;
  }

  return value;
}

/** Apply default values to optional config fields. */
function applyDefaults(raw: Record<string, unknown>): void {
  if (!raw["polling"]) {
    raw["polling"] = { ...DEFAULTS.polling };
  } else {
    const polling = raw["polling"] as Record<string, unknown>;
    if (!polling["interval"]) polling["interval"] = DEFAULTS.polling.interval;
    if (!polling["sources"]) polling["sources"] = [...DEFAULTS.polling.sources];
  }

  if (!raw["filters"]) {
    raw["filters"] = { ...DEFAULTS.filters, ignore_patterns: [] };
  } else {
    const filters = raw["filters"] as Record<string, unknown>;
    if (filters["min_status_code"] === undefined) {
      filters["min_status_code"] = DEFAULTS.filters.min_status_code;
    }
    if (!filters["ignore_patterns"]) filters["ignore_patterns"] = [];
    if (filters["max_alerts_per_interval"] === undefined) {
      filters["max_alerts_per_interval"] =
        DEFAULTS.filters.max_alerts_per_interval;
    }
  }
}

/** Validate the config and collect all errors. */
function validate(config: Record<string, unknown>): string[] {
  const errors: string[] = [];

  // supabase.access_token
  const supabase = config["supabase"] as
    | Record<string, unknown>
    | undefined;
  if (
    !supabase ||
    typeof supabase["access_token"] !== "string" ||
    !supabase["access_token"]
  ) {
    errors.push("supabase.access_token is required");
  }

  // projects
  const projects = config["projects"];
  if (!Array.isArray(projects) || projects.length === 0) {
    errors.push("at least one project is required");
  } else {
    for (const project of projects) {
      const p = project as Record<string, unknown>;
      const ref = p["ref"] as string | undefined;
      if (!ref || !/^[a-zA-Z0-9]{12,}$/.test(ref)) {
        errors.push(
          `project ref "${ref ?? ""}" is invalid (expected alphanumeric, min 12 chars)`,
        );
      }
      if (!p["name"] || typeof p["name"] !== "string") {
        errors.push(`project name is required for ref "${ref ?? ""}"`);
      }
    }
  }

  // channels
  const channels = config["channels"] as
    | Record<string, unknown>
    | undefined;
  if (!channels || Object.keys(channels).length === 0) {
    errors.push("at least one channel must be configured");
  } else {
    const telegram = channels["telegram"] as
      | Record<string, unknown>
      | undefined;
    if (telegram) {
      if (!telegram["bot_token"] || typeof telegram["bot_token"] !== "string") {
        errors.push("channels.telegram.bot_token is required");
      }
      if (!telegram["chat_id"] || typeof telegram["chat_id"] !== "string") {
        errors.push("channels.telegram.chat_id is required");
      }
    }
  }

  // polling.interval
  const polling = config["polling"] as Record<string, unknown> | undefined;
  if (polling && polling["interval"]) {
    try {
      parseDuration(polling["interval"] as string);
    } catch {
      errors.push(
        `polling.interval "${polling["interval"]}" is not a valid duration`,
      );
    }
  }

  return errors;
}

/**
 * Load, interpolate, and validate watchdog.config.yaml.
 * Throws on missing file, invalid YAML, missing required fields,
 * or unresolvable environment variables.
 */
export async function loadConfig(
  path = "./watchdog.config.yaml",
): Promise<WatchdogConfig> {
  const text = await Deno.readTextFile(path);
  const raw = parseYaml(text) as Record<string, unknown>;

  // Apply defaults before interpolation so defaults don't need env vars
  applyDefaults(raw);

  // Interpolate environment variables
  const envErrors: string[] = [];
  const interpolated = interpolateEnv(raw, "", envErrors) as Record<
    string,
    unknown
  >;

  // Validate
  const validationErrors = validate(interpolated);

  const allErrors = [...envErrors, ...validationErrors];
  if (allErrors.length > 0) {
    throw new Error(
      `Config error:\n${allErrors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  return interpolated as unknown as WatchdogConfig;
}
