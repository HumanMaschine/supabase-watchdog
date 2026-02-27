---
type: phase
domain: mvp
phase: 1
status: planning
parent: "[[mvp/plan]]"
tags:
  - watchdog/mvp
  - watchdog/phase
---

> [!nav] Navigation
> **Parent:** [[mvp/plan|MVP Implementation Plan]]
> **Spec:** [[mvp/spec|MVP Spec]]
> **Depends on:** None (foundation phase)
> **Next:** [[mvp/phases/phase-2-supabase-source|Phase 2: Supabase Source]] | [[mvp/phases/phase-3-telegram-channel|Phase 3: Telegram Channel]]

# Watchdog — Phase 1: Foundation & Config

## Context

```
vision-spec
  └── mvp/spec
        └── mvp/plan
              └── ► Phase 1: Foundation & Config (this document)
                    Phase 2: Supabase Source
                    Phase 3: Telegram Channel
                    Phase 4: Orchestration
                    Phase 5: Bot Commands
                    Phase 6: Deployment & Docs
```

Supabase Watchdog is a lightweight error monitoring tool that polls the Supabase Management API for error-level events and delivers alerts to notification channels. This phase establishes the project foundation that every subsequent phase builds on.

Nothing exists yet — this is the first phase. It creates the Deno project configuration, defines every core TypeScript interface (`ErrorEvent`, `Source`, `Processor`, `ProcessedEvent`, `Channel`), builds the YAML configuration loader with environment variable interpolation and validation, and provides an example config file. After this phase, the project compiles, all shared types are importable, and config can be loaded and validated — but nothing polls, processes, or sends.

Phases 2 (Supabase Source) and 3 (Telegram Channel) follow in parallel. Both import types and config from this phase. Do not build any source, processor, or channel logic here.

---

## Scope Boundaries

### This phase DOES:

- Create `deno.json` with TypeScript compiler options and an import map for external dependencies
- Define all core interfaces in `types.ts`: `ErrorEvent`, `Source`, `Processor`, `ProcessedEvent`, `Channel`
- Define typed config interfaces in `types.ts`: `WatchdogConfig`, `ProjectConfig`, `PollingConfig`, `FiltersConfig`, `TelegramChannelConfig`
- Implement `config.ts` with `loadConfig()` that reads and parses `watchdog.config.yaml`
- Implement `${ENV_VAR}` interpolation in string config values
- Implement config validation: required fields, project ref format, interval parsing, env var resolution
- Create `watchdog.config.example.yaml` with all options and inline comments

### This phase does NOT:

- Create `main.ts` entry point or any orchestration — Phase 4
- Implement any source plugins (`sources/`) — Phase 2
- Implement any processor plugins (`processors/`) — Phase 3
- Implement any channel plugins (`channels/`) — Phase 3
- Set up `Deno.cron()` or any scheduling — Phase 4
- Create `Dockerfile` or deployment artifacts — Phase 6
- Create `README.md` — Phase 6

### Boundary details:

- The `Source`, `Processor`, and `Channel` interfaces are defined here but not implemented. Phases 2 and 3 provide the first implementations.
- `watchdog.config.example.yaml` is a documentation artifact with placeholder values — it is not the runtime config file.
- Config validation throws on missing required fields but uses sensible defaults for optional fields (e.g., `polling.interval` defaults to `"5m"`, `filters.min_status_code` defaults to `500`).

---

## Project Integration

This is the foundation phase — there is no existing code. All files are new. The patterns established here (module exports, error handling, config access) become the conventions for all subsequent phases.

### Files modified

No files modified — all files are new.

### New files

```
deno.json                        ← Deno config, import map, compiler options
types.ts                         ← Core interfaces + config types
config.ts                        ← loadConfig(), env interpolation, validation
watchdog.config.example.yaml     ← Documented example configuration
```

### Dependencies to add

```jsonc
// deno.json imports
{
  "@std/yaml": "jsr:@std/yaml@^1",
  "@std/fs": "jsr:@std/fs@^1"
}
```

No Telegram or other external dependencies yet — those are added in the phases that need them.

---

## 1. Deno Project Configuration

Create `deno.json` with strict TypeScript, the import map, and placeholder tasks:

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  },
  "imports": {
    "@std/yaml": "jsr:@std/yaml@^1",
    "@std/fs": "jsr:@std/fs@^1"
  },
  "tasks": {
    "dev": "deno run --allow-read --allow-env --allow-net --watch main.ts",
    "start": "deno run --allow-read --allow-env --allow-net main.ts"
  }
}
```

Tasks reference `main.ts` which doesn't exist yet — that's fine; they're placeholders for Phase 4.

---

## 2. Core Type Definitions

`types.ts` defines every shared interface. These are the contracts between all layers of the system.

### 2.1 Error Event Types

```typescript
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
```

### 2.2 Plugin Interfaces

```typescript
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
```

### 2.3 Config Types

```typescript
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
}
```

---

## 3. Configuration Loader

`config.ts` exports a single `loadConfig()` function. It handles three concerns: file reading + YAML parsing, environment variable interpolation, and validation.

### 3.1 Public API

```typescript
import type { WatchdogConfig } from "./types.ts";

/**
 * Load, interpolate, and validate watchdog.config.yaml.
 * Throws on missing file, invalid YAML, missing required fields,
 * or unresolvable environment variables.
 */
export async function loadConfig(
  path?: string,
): Promise<WatchdogConfig>;
```

`path` defaults to `"./watchdog.config.yaml"`.

### 3.2 Environment Variable Interpolation

Walk all string values in the parsed YAML object. For any string matching the pattern `${VAR_NAME}`, replace it with `Deno.env.get("VAR_NAME")`. If the env var is undefined or empty, throw with a descriptive error:

```
Config error: environment variable "SUPABASE_ACCESS_TOKEN" is not set (referenced in supabase.access_token)
```

The interpolation is recursive — it processes nested objects and arrays. Only full-string `"${VAR}"` patterns are replaced (not partial interpolation like `"prefix_${VAR}_suffix"`).

### 3.3 Validation Rules

After interpolation, validate the config:

| Field | Rule | Error |
|-------|------|-------|
| `supabase.access_token` | Required, non-empty string | `"supabase.access_token is required"` |
| `projects` | Required, non-empty array | `"at least one project is required"` |
| `projects[].ref` | 12+ alphanumeric characters | `"project ref \"X\" is invalid (expected alphanumeric, min 12 chars)"` |
| `projects[].name` | Required, non-empty string | `"project name is required for ref \"X\""` |
| `channels` | At least one channel configured | `"at least one channel must be configured"` |
| `channels.telegram.bot_token` | Required if telegram configured | `"channels.telegram.bot_token is required"` |
| `channels.telegram.chat_id` | Required if telegram configured | `"channels.telegram.chat_id is required"` |
| `polling.interval` | Parseable duration string (e.g., `"5m"`, `"1h"`) | `"polling.interval \"X\" is not a valid duration"` |

### 3.4 Defaults

Apply defaults before validation for optional fields:

```typescript
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
    ignore_patterns: [],
    max_alerts_per_interval: 20,
  },
};
```

### 3.5 Duration Parsing

Implement a `parseDuration(input: string): number` helper that converts duration strings to milliseconds:

| Input | Output |
|-------|--------|
| `"30s"` | `30_000` |
| `"5m"` | `300_000` |
| `"1h"` | `3_600_000` |
| `"2h30m"` | `9_000_000` |

Supported units: `s` (seconds), `m` (minutes), `h` (hours). Minimum allowed: 60,000ms (1 minute). Throw if unparseable or below minimum.

Export `parseDuration` — Phase 4 needs it for cron setup and Phase 5 needs it for the `/errors <timeframe>` command.

---

## 4. Example Configuration

`watchdog.config.example.yaml` serves as both documentation and a starting point. Every field has an inline comment:

```yaml
# Supabase Watchdog Configuration
# Copy this file to watchdog.config.yaml and fill in your values.

supabase:
  # Personal access token from https://supabase.com/dashboard/account/tokens
  # Use an environment variable — never paste the token directly.
  access_token: "${SUPABASE_ACCESS_TOKEN}"

projects:
  # Add one entry per Supabase project you want to monitor.
  # The ref is the 12-character project ID from your project URL.
  - ref: "your-project-ref"
    name: "my-project"
  # - ref: "another-ref-here"
  #   name: "my-other-project"
  #   severity: "critical"  # optional: only alert on critical errors

polling:
  # How often to check for new errors. Minimum: 1m.
  interval: "5m"
  # Which Supabase log sources to monitor.
  sources:
    - edge_logs
    - auth_logs
    - postgres_logs
    - storage_logs
    - realtime_logs
    - postgrest_logs
    # - supavisor_logs  # uncomment if needed

filters:
  # Only alert on HTTP status codes >= this value.
  min_status_code: 500
  # Errors matching these patterns are silently dropped.
  ignore_patterns:
    - "healthcheck"
    - "favicon.ico"
  # Maximum alerts per polling interval (prevents message floods).
  max_alerts_per_interval: 20

channels:
  telegram:
    # Create a bot via @BotFather and paste the token here.
    bot_token: "${TELEGRAM_BOT_TOKEN}"
    # Chat or group ID where alerts will be sent.
    # Tip: send a message to your bot, then visit
    # https://api.telegram.org/bot<TOKEN>/getUpdates to find the chat_id.
    chat_id: "${TELEGRAM_CHAT_ID}"
```

---

## Open Questions

| # | Question | Status | Leaning |
|---|----------|--------|---------|
| 1 | Should `parseDuration` support compound durations like `"2h30m"` or just single-unit like `"5m"`? | Open | Single-unit for MVP simplicity; compound is a nice-to-have. |
| 2 | Should config validation fail hard on the first error or collect all errors and report them together? | Open | Collect all — better developer experience on first setup. |
| 3 | Should partial `${VAR}` interpolation (e.g., `"prefix_${VAR}_suffix"`) be supported or only full-string replacement? | Resolved | Full-string only. Secrets should not be concatenated with other text. |
