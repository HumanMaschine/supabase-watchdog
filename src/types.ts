// ── Error Event Types ────────────────────────────────────────────────

/** Canonical representation of an error from any source. */
export interface ErrorEvent {
  /** Human-readable project name from config. */
  project: string;
  /** Supabase project ref (12-char alphanumeric ID). */
  projectRef: string;
  /** Log source identifier, e.g. "edge_logs", "auth_logs". */
  source: string;
  /** ISO 8601 timestamp of the error. */
  timestamp: string;
  /** HTTP status code, if applicable. */
  statusCode?: number;
  /** Error message or description. */
  message: string;
  /** Arbitrary additional data from the source. */
  metadata?: Record<string, unknown>;
}

/** An ErrorEvent enriched by a processor. */
export interface ProcessedEvent extends ErrorEvent {
  /** AI-generated analysis (future, optional). */
  analysis?: string;
  /** Classified severity level. */
  severity?: "info" | "warning" | "error" | "critical";
  /** AI-suggested remediation (future, optional). */
  suggestedAction?: string;
}

// ── Plugin Interfaces ────────────────────────────────────────────────

/** A source polls an external system for errors. */
export interface Source {
  name: string;
  poll(since: Date): Promise<ErrorEvent[]>;
}

/** A processor transforms/enriches error events. */
export interface Processor {
  name: string;
  process(events: ErrorEvent[]): Promise<ProcessedEvent[]>;
}

/** A channel delivers processed events to a notification destination. */
export interface Channel {
  name: string;
  send(events: ProcessedEvent[]): Promise<void>;
  /** Optional: register interactive commands (e.g., Telegram bot commands). */
  registerCommands?(): void;
}

// ── Config Types ─────────────────────────────────────────────────────

export interface ProjectConfig {
  /** Supabase project ref (12-char alphanumeric). */
  ref: string;
  /** Human-readable name for this project. */
  name: string;
  /** Optional: only alert at this severity or above. */
  severity?: "info" | "warning" | "error" | "critical";
}

export interface PollingConfig {
  /** Polling interval as a duration string, e.g. "5m", "1h". Default: "5m". */
  interval: string;
  /** Log sources to query. Default: all sources. */
  sources: string[];
}

export interface FiltersConfig {
  /** Minimum HTTP status code to treat as error. Default: 500. */
  min_status_code: number;
  /** Patterns to ignore (substring match against error message). */
  ignore_patterns: string[];
  /** Max alerts to send per polling interval. Default: 20. */
  max_alerts_per_interval: number;
}

export interface TelegramChannelConfig {
  /** Telegram bot token (should use ${ENV_VAR} interpolation). */
  bot_token: string;
  /** Telegram chat or group ID. */
  chat_id: string;
}

export interface ChannelsConfig {
  telegram?: TelegramChannelConfig;
}

export interface WatchdogConfig {
  supabase: {
    access_token: string;
  };
  projects: ProjectConfig[];
  polling: PollingConfig;
  filters: FiltersConfig;
  channels: ChannelsConfig;
  /** Telegram transport mode: "webhook" (Deno Deploy) or "polling" (Docker). */
  telegram_mode: "webhook" | "polling";
  /** Public base URL for webhook mode, e.g. "https://my-watchdog.deno.dev". */
  base_url?: string;
  /** Optional token to protect the dashboard. If set, requests need ?token= or Authorization header. */
  dashboard_token?: string;
}

// ── Config Result ───────────────────────────────────────────────────

/** Result of attempting to load config. Allows graceful setup mode. */
export type ConfigResult =
  | { configured: true; config: WatchdogConfig }
  | { configured: false; missing: string[] };

// ── KV State Types ──────────────────────────────────────────────────

export interface PollCycleRecord {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  ok: boolean;
  errors_found: number;
  alerts_sent: number;
  failures: { project: string; source: string; error: string }[];
}

export interface DailyStats {
  polls: number;
  errors_found: number;
  alerts_sent: number;
}

export interface SourceHealthStatus {
  last_poll: string;
  ok: boolean;
  last_error?: string;
}
