import { parse as parseYaml } from "@std/yaml";
import type { ConfigResult, WatchdogConfig } from "./types.ts";
import { log } from "./logger.ts";

const ENV_VAR_PATTERN = /^\$\{([^}]+)\}$/;

const DEFAULT_SOURCES = [
  "edge_logs",
  "auth_logs",
  "postgres_logs",
  "storage_logs",
  "realtime_logs",
  "postgrest_logs",
  "supavisor_logs",
];

const DEFAULTS = {
  polling: {
    interval: "5m",
    sources: DEFAULT_SOURCES,
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
    raw["polling"] = { ...DEFAULTS.polling, sources: [...DEFAULTS.polling.sources] };
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
  const supabase = config["supabase"] as Record<string, unknown> | undefined;
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
  const channels = config["channels"] as Record<string, unknown> | undefined;
  if (!channels || Object.keys(channels).length === 0) {
    errors.push("at least one channel must be configured");
  } else {
    const telegram = channels["telegram"] as Record<string, unknown> | undefined;
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

// ── Env-var config builder ──────────────────────────────────────────

function validateInt(value: string, name: string): number {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`${name} must be a number, got "${value}"`);
  }
  return parsed;
}

/** Required env vars for the env-var config path. */
const REQUIRED_ENV_VARS = [
  "SUPABASE_ACCESS_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "WATCHDOG_PROJECTS",
] as const;

/**
 * Parse WATCHDOG_PROJECTS env var.
 * Format: "ref1:name1,ref2:name2"
 */
function parseProjectsEnv(value: string): { ref: string; name: string }[] {
  return value.split(",").map((entry) => {
    const colonIndex = entry.indexOf(":");
    if (colonIndex === -1) {
      throw new Error(
        `Invalid WATCHDOG_PROJECTS entry "${entry}" — expected "ref:name" format`,
      );
    }
    const ref = entry.slice(0, colonIndex).trim();
    const name = entry.slice(colonIndex + 1).trim();
    if (!ref || !name) {
      throw new Error(
        `Invalid WATCHDOG_PROJECTS entry "${entry}" — ref and name must not be empty`,
      );
    }
    return { ref, name };
  });
}

/**
 * Check which required env vars are set.
 * Returns the list of missing var names.
 */
export function checkRequiredEnvVars(): string[] {
  const missing: string[] = [];
  for (const varName of REQUIRED_ENV_VARS) {
    if (!Deno.env.get(varName)) {
      missing.push(varName);
    }
  }
  return missing;
}

/**
 * Build a WatchdogConfig entirely from environment variables.
 * Throws on malformed values (this is invalid config, not missing config).
 */
function buildConfigFromEnv(): WatchdogConfig {
  const accessToken = Deno.env.get("SUPABASE_ACCESS_TOKEN")!;
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID")!;
  const projectsRaw = Deno.env.get("WATCHDOG_PROJECTS")!;

  const projects = parseProjectsEnv(projectsRaw);

  const interval = Deno.env.get("WATCHDOG_INTERVAL") || DEFAULTS.polling.interval;
  const sourcesRaw = Deno.env.get("WATCHDOG_SOURCES");
  const sources = sourcesRaw
    ? sourcesRaw.split(",").map((s) => s.trim())
    : [...DEFAULTS.polling.sources];

  const minStatus = Deno.env.get("WATCHDOG_MIN_STATUS");
  const ignoreRaw = Deno.env.get("WATCHDOG_IGNORE_PATTERNS");
  const maxAlerts = Deno.env.get("WATCHDOG_MAX_ALERTS");

  const telegramModeRaw = Deno.env.get("WATCHDOG_TELEGRAM_MODE") || "polling";
  if (telegramModeRaw !== "webhook" && telegramModeRaw !== "polling") {
    throw new Error(
      `WATCHDOG_TELEGRAM_MODE must be "webhook" or "polling", got "${telegramModeRaw}"`,
    );
  }
  const telegramMode = telegramModeRaw;
  const baseUrl = Deno.env.get("WATCHDOG_BASE_URL");
  const dashboardToken = Deno.env.get("WATCHDOG_DASHBOARD_TOKEN");

  const config: WatchdogConfig = {
    supabase: { access_token: accessToken },
    projects,
    polling: { interval, sources },
    filters: {
      min_status_code: minStatus ? validateInt(minStatus, "WATCHDOG_MIN_STATUS") : DEFAULTS.filters.min_status_code,
      ignore_patterns: ignoreRaw ? ignoreRaw.split(",").map((s) => s.trim()) : [],
      max_alerts_per_interval: maxAlerts
        ? validateInt(maxAlerts, "WATCHDOG_MAX_ALERTS")
        : DEFAULTS.filters.max_alerts_per_interval,
    },
    channels: {
      telegram: { bot_token: botToken, chat_id: chatId },
    },
    telegram_mode: telegramMode,
    base_url: baseUrl,
    dashboard_token: dashboardToken,
  };

  // Validate the built config
  const raw = config as unknown as Record<string, unknown>;
  const errors = validate(raw);
  if (errors.length > 0) {
    throw new Error(
      `Config error (from env vars):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  return config;
}

// ── Main config loader ──────────────────────────────────────────────

/**
 * Load config from YAML file or environment variables.
 *
 * Priority:
 * 1. If watchdog.config.yaml exists, load from YAML (throws on invalid YAML)
 * 2. If no YAML, check env vars. If all required vars are set, build from env.
 * 3. If neither, return { configured: false } with list of missing vars.
 */
export async function loadConfig(
  path = "./watchdog.config.yaml",
): Promise<ConfigResult> {
  // Try YAML first
  try {
    const text = await Deno.readTextFile(path);
    const raw = parseYaml(text) as Record<string, unknown>;

    applyDefaults(raw);

    const envErrors: string[] = [];
    const interpolated = interpolateEnv(raw, "", envErrors) as Record<string, unknown>;

    const validationErrors = validate(interpolated);
    const allErrors = [...envErrors, ...validationErrors];

    if (allErrors.length > 0) {
      // YAML exists but is invalid — hard fail (Docker/self-hosted behavior)
      throw new Error(
        `Config error:\n${allErrors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }

    // Add v0.2 fields from env vars (these are never in YAML)
    const config = interpolated as unknown as WatchdogConfig;
    config.telegram_mode = (Deno.env.get("WATCHDOG_TELEGRAM_MODE") || "polling") as "webhook" | "polling";
    config.base_url = Deno.env.get("WATCHDOG_BASE_URL");
    config.dashboard_token = Deno.env.get("WATCHDOG_DASHBOARD_TOKEN");

    return { configured: true, config };
  } catch (err) {
    // If file doesn't exist, fall through to env-var path
    if (err instanceof Deno.errors.NotFound) {
      log.info("No watchdog.config.yaml found, checking environment variables");
    } else {
      // YAML exists but is broken — re-throw (hard fail)
      throw err;
    }
  }

  // Try env vars
  const missing = checkRequiredEnvVars();
  if (missing.length > 0) {
    return { configured: false, missing };
  }

  try {
    const config = buildConfigFromEnv();
    return { configured: true, config };
  } catch (err) {
    // Env vars present but malformed — hard fail
    throw err;
  }
}
