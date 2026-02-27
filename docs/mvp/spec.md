---
type: spec
domain: mvp
status: design
version: 0.1.0
parent: "[[vision-spec]]"
tags:
  - watchdog/mvp
  - watchdog/spec
---

> [!nav] Navigation
> **Parent:** [[vision-spec|Vision Spec]]
> **Siblings:** (none yet)
> **Implementation Plan:** [[mvp/plan|MVP Implementation Plan]]

# Watchdog — MVP Specification

**Version:** 0.1.0
**Last Updated:** 2026-02-23
**Status:** Design

---

## 1. Purpose

The MVP domain delivers the first usable version of Supabase Watchdog: a single deployment that polls the Supabase Management API for error-level events across all configured projects and sends formatted alerts to a Telegram chat. It also exposes on-demand bot commands so developers can query errors interactively.

The goal is to prove the core value proposition — **free, zero-touch error alerting for Supabase Pro-plan users** — with the smallest possible surface area while establishing the plugin architecture that all future domains (channels, smarts, AI analysis) will build on.

## 2. Core Concepts

| Term | Definition |
|------|-----------|
| **Source** | A plugin that knows how to fetch errors from an external system. The MVP has one source: the Supabase Management API poller. |
| **Processor** | A plugin that transforms `ErrorEvent`s before they reach a channel. The MVP uses a passthrough processor (no transformation). |
| **Channel** | A plugin that delivers processed events to a notification destination. The MVP has one channel: Telegram. |
| **ErrorEvent** | The canonical internal representation of an error. All sources produce these; all channels consume them. |
| **ProcessedEvent** | An `ErrorEvent` enriched by a processor. In the MVP this is identical to the input event. |
| **Polling window** | The time span between the current poll and the previous poll. Events are queried with `since = lastPollTime`. |
| **Project ref** | The unique 12-character identifier for a Supabase project (e.g., `abcdefghijkl`). |

## 3. Architecture

### 3.1 Plugin Layers

The codebase is structured around three pluggable layers, each defined by a TypeScript interface. Adding capabilities means adding a file, not restructuring the project.

```
supabase-watchdog/
├── main.ts                  # Entry point: cron setup, bot init, orchestration
├── config.ts                # Config loading and validation
├── types.ts                 # Shared types (ErrorEvent, Source, Processor, Channel)
│
├── sources/                 # WHERE errors come from
│   ├── mod.ts               # Source interface + registry
│   └── supabase.ts          # Supabase Management API poller
│
├── processors/              # WHAT happens before notification
│   ├── mod.ts               # Processor interface + registry
│   └── passthrough.ts       # MVP: forward as-is
│
├── channels/                # WHERE alerts go
│   ├── mod.ts               # Channel interface + registry
│   └── telegram.ts          # Telegram bot (alerts + commands)
│
├── watchdog.config.yaml     # User configuration
├── deno.json                # Deno configuration
├── Dockerfile               # Docker deployment option
└── README.md
```

### 3.2 Core Interfaces

```typescript
// types.ts

interface ErrorEvent {
  project: string;           // Human-readable project name
  projectRef: string;        // Supabase project ref (12-char ID)
  source: string;            // Log source, e.g. "edge_logs", "auth_logs"
  timestamp: string;         // ISO 8601 timestamp
  statusCode?: number;       // HTTP status code (if applicable)
  message: string;           // Error message / description
  metadata?: Record<string, unknown>;
}

interface Source {
  name: string;
  poll(since: Date): Promise<ErrorEvent[]>;
}

interface Processor {
  name: string;
  process(events: ErrorEvent[]): Promise<ProcessedEvent[]>;
}

interface ProcessedEvent extends ErrorEvent {
  analysis?: string;         // Future: AI-generated analysis
  severity?: "info" | "warning" | "error" | "critical";
  suggestedAction?: string;  // Future: AI-suggested fix
}

interface Channel {
  name: string;
  send(events: ProcessedEvent[]): Promise<void>;
  registerCommands?(): void; // Optional: for interactive channels
}
```

### 3.3 Data Flow

```
1. Cron triggers (every N minutes, default 5)
     │
2. For each project in config:
     │── Source.poll(lastPollTime)
     │     └── Queries Management API for errors since last poll
     │
3. Deduplicate & filter
     │     └── Remove duplicates within window, apply ignore patterns
     │
4. Processor.process(events)
     │     └── MVP: passthrough (no transformation)
     │
5. Channel.send(processedEvents)
           └── Format & send to Telegram
```

## 4. Supabase Management API Integration

### 4.1 Endpoint

```
GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs.all
```

- **Authentication:** `Authorization: Bearer <personal-access-token>`
- **Rate limit:** 120 requests/minute (shared globally across all Management API calls)
- **Query window:** Maximum 24 hours per request
- **Cost:** Free and unmetered

### 4.2 Log Sources

The MVP queries all available log sources:

| Source | Captures |
|--------|----------|
| `edge_logs` | Edge Function invocations, HTTP errors |
| `auth_logs` | Authentication events, failed logins |
| `postgres_logs` | Database errors, slow queries |
| `storage_logs` | Storage upload/download errors |
| `realtime_logs` | Realtime subscription errors |
| `postgrest_logs` | PostgREST API errors |
| `supavisor_logs` | Connection pooler errors |

### 4.3 Error Detection Strategy

Events are classified as errors when any of the following conditions are met:

- HTTP status code >= 500
- Log contains exception/error keywords (configurable)
- Postgres severity level indicates error

### 4.4 Rate Budget

With a 5-minute polling interval, each project consumes ~7 requests per poll (one per log source). For 15 projects: `15 * 7 = 105 req/5min = 21 req/min` — well within the 120 req/min limit.

## 5. Telegram Channel

### 5.1 Alert Format

Each error alert is a formatted Telegram message containing:

- Project name and ref
- Service / log source
- Error message (truncated at 4096 chars if needed)
- Timestamp
- Status code (if applicable)

### 5.2 Bot Commands

| Command | Description |
|---------|-------------|
| `/check` | Immediately poll all projects and report errors |
| `/check <project>` | Poll a specific project by name or ref |
| `/errors <timeframe>` | Retrieve errors from the last N minutes/hours (e.g., `/errors 30m`, `/errors 2h`) |
| `/status` | Show monitoring status: last poll time, projects monitored, errors in last poll |

### 5.3 Rate Limiting

- Telegram allows max 30 messages/second to different chats, 20 messages/minute to the same group
- The channel plugin batches alerts and respects a configurable `max_alerts_per_interval` to prevent message floods
- Messages exceeding 4096 characters are truncated with a "... (truncated)" suffix

## 6. Configuration

### 6.1 Config File

Configuration is loaded from `watchdog.config.yaml` in the project root:

```yaml
supabase:
  access_token: "${SUPABASE_ACCESS_TOKEN}"

projects:
  - ref: "abcdefghijkl"
    name: "my-app-prod"
  - ref: "mnopqrstuvwx"
    name: "my-app-staging"
    severity: "critical"       # optional: only alert on critical errors

polling:
  interval: "5m"               # polling frequency
  sources:                     # which log sources to query
    - edge_logs
    - auth_logs
    - postgres_logs
    - storage_logs
    - realtime_logs
    - postgrest_logs

filters:
  min_status_code: 500
  ignore_patterns:             # errors matching these are silently dropped
    - "healthcheck"
    - "favicon.ico"
  max_alerts_per_interval: 20  # cap to prevent message floods

channels:
  telegram:
    bot_token: "${TELEGRAM_BOT_TOKEN}"
    chat_id: "${TELEGRAM_CHAT_ID}"
```

### 6.2 Environment Variable Interpolation

Strings wrapped in `${...}` are resolved from environment variables at load time. Secrets (access tokens, bot tokens) should always use this pattern rather than being hardcoded.

### 6.3 Validation

Config loading validates:

- Required fields are present (`supabase.access_token`, at least one project, at least one channel)
- Project refs are valid format (12 alphanumeric characters)
- Polling interval is parseable and >= 1 minute
- Environment variable references resolve to non-empty values

## 7. Deployment

### 7.1 Deno Deploy (Recommended)

Zero-infrastructure deployment with native `Deno.cron()` support. Free tier provides 1M requests/month and 100K KV operations — more than sufficient.

### 7.2 Docker

Self-hosted option for private networks or full control. Standard `Dockerfile` with Deno runtime.

### 7.3 Any Deno Runtime

The project is a standard Deno application with no platform-specific dependencies. Runs on any machine with Deno installed.

## 8. Deduplication

Within a single polling window, the same error may appear multiple times (e.g., a failing edge function hit repeatedly). The MVP deduplicates by hashing `(projectRef, source, message)` and only alerting once per unique combination per window.

Cross-window deduplication (suppressing recurring known errors) is out of scope for the MVP and belongs to the **smarts** domain.

## 9. What the MVP Does NOT Cover

These are explicitly deferred to future domains:

| Capability | Future Domain |
|------------|---------------|
| Discord, Slack, webhook channels | **channels** |
| Error grouping, severity classification, history storage | **smarts** |
| AI-powered root cause analysis | **ai-analysis** |
| Natural language log queries | **conversational** |
| Codebase-aware triage, auto-fix PRs | **agent-integration** |
| Web dashboard / UI | Future consideration |

---

## Open Questions

| # | Question | Status | Resolution |
|---|----------|--------|------------|
| 1 | Should config validation fail hard (crash on startup) or warn and use defaults for optional fields? | Open | |
| 2 | Should the Telegram bot use polling (`getUpdates`) or webhooks for receiving commands? Webhooks are more efficient on Deno Deploy but require a public URL. | Open | |
| 3 | How should the MVP handle Management API downtime or auth failures? Retry with backoff? Alert the user via Telegram? | Open | |
| 4 | Should `supavisor_logs` be included by default or opt-in, given it may produce noise on busy projects? | Open | |
