---
type: phase
domain: mvp
phase: 2
status: done
parent: "[[mvp/plan]]"
depends_on:
  - "[[mvp/phases/phase-1-foundation]]"
tags:
  - watchdog/mvp
  - watchdog/phase
---

> [!nav] Navigation
> **Parent:** [[mvp/plan|MVP Implementation Plan]]
> **Spec:** [[mvp/spec|MVP Spec]]
> **Depends on:** [[mvp/phases/phase-1-foundation|Phase 1: Foundation & Config]]
> **Prev:** [[mvp/phases/phase-1-foundation|Phase 1: Foundation & Config]]
> **Next:** [[mvp/phases/phase-3-telegram-channel|Phase 3: Telegram Channel]] | [[mvp/phases/phase-4-orchestration|Phase 4: Orchestration]]

# Watchdog — Phase 2: Supabase Source

## Context

```
vision-spec
  └── mvp/spec
        └── mvp/plan
              Phase 1: Foundation & Config  ✓
              ► Phase 2: Supabase Source (this document)
              Phase 3: Telegram Channel
              Phase 4: Orchestration
              Phase 5: Bot Commands
              Phase 6: Deployment & Docs
```

Supabase Watchdog is a lightweight error monitoring tool that polls the Supabase Management API for error-level events and delivers alerts to notification channels. This phase builds the first (and only MVP) source plugin — the Supabase Management API poller.

Phase 1 established the project foundation: `deno.json` with strict TypeScript and imports, `types.ts` with all core interfaces (`ErrorEvent`, `Source`, `Processor`, `ProcessedEvent`, `Channel`) and config types, `config.ts` with YAML loading, `${ENV_VAR}` interpolation, validation, and `parseDuration()`, plus the example config file. The project compiles and config can be loaded, but nothing fetches data yet.

This phase creates `sources/mod.ts` (the source registry barrel) and `sources/supabase.ts` (the Management API poller). After this phase, the `SupabaseSource` can be instantiated with a loaded config and its `poll(since)` method will query the Management API for each configured project × log source, filter for error-level events, and return `ErrorEvent[]`. It does not send alerts — that's the channel's job.

Phase 3 (Telegram Channel) can be built in parallel with this phase since both depend only on Phase 1. Phase 4 (Orchestration) wires the source, processor, and channel together into the running pipeline — do not build any orchestration or scheduling here.

---

## Scope Boundaries

### This phase DOES:

- Create `sources/mod.ts` as a barrel module that re-exports the `Source` interface and the `SupabaseSource` class
- Create `sources/supabase.ts` implementing the `Source` interface
- Implement `SupabaseSource.poll(since: Date)` that queries the Management API for each project × log source combination
- Build SQL queries per log source with error-detection clauses (status >= 500, error severity, exception keywords)
- Parse Management API JSON responses into `ErrorEvent[]`
- Handle API errors gracefully (non-200 responses, network failures) by logging warnings and continuing with remaining projects/sources
- Respect the 24-hour maximum query window by clamping `since` if it's older than 24 hours

### This phase does NOT:

- Implement rate limiting or request throttling — Phase 4 controls polling frequency
- Implement deduplication of events — Phase 4 handles dedup before passing to channels
- Send any notifications or alerts — Phase 3 (channel) and Phase 4 (orchestration)
- Set up `Deno.cron()` or any scheduling — Phase 4
- Create `main.ts` or any entry point — Phase 4
- Implement processors or channels — Phase 3
- Store or persist any state (last poll times, error history) — Phase 4 tracks `lastPollTime`

### Boundary details:

- The `SupabaseSource` constructor takes a `WatchdogConfig` and extracts what it needs (access token, projects list, polling sources, filters). It does not own the config lifecycle.
- `poll(since)` returns all errors found across all projects and sources in a single flat `ErrorEvent[]`. Deduplication and filtering by `ignore_patterns` are done here (at the source level) since the source understands the raw data best.
- The `since` parameter is always provided by the caller (Phase 4's orchestrator). This phase does not track or persist `lastPollTime`.

---

## Project Integration

This phase adds the first plugin module directory (`sources/`) alongside the existing root-level foundation files. It imports `ErrorEvent`, `Source`, and config types from `types.ts`, and uses `WatchdogConfig` from the loaded config. No existing files are modified.

### Files modified

No existing files modified.

### New files

```
sources/mod.ts        ← Barrel: re-exports Source interface + SupabaseSource class
sources/supabase.ts   ← Management API poller implementing Source interface
```

### Dependencies to add

No new dependencies. The Management API is called with `fetch()` (built into Deno). YAML parsing and config loading are already handled by Phase 1.

---

## 1. Source Registry Module

`sources/mod.ts` is a simple barrel module:

```typescript
export type { Source } from "../types.ts";
export { SupabaseSource } from "./supabase.ts";
```

---

## 2. SupabaseSource Class

`sources/supabase.ts` exports the `SupabaseSource` class.

### 2.1 Class Structure

```typescript
import type { ErrorEvent, Source, WatchdogConfig } from "../types.ts";

const API_BASE = "https://api.supabase.com/v1";
const MAX_QUERY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export class SupabaseSource implements Source {
  readonly name = "supabase";

  private accessToken: string;
  private projects: WatchdogConfig["projects"];
  private sources: string[];
  private minStatusCode: number;
  private ignorePatterns: string[];

  constructor(config: WatchdogConfig) {
    this.accessToken = config.supabase.access_token;
    this.projects = config.projects;
    this.sources = config.polling.sources;
    this.minStatusCode = config.filters.min_status_code;
    this.ignorePatterns = config.filters.ignore_patterns;
  }

  async poll(since: Date): Promise<ErrorEvent[]> { ... }
}
```

### 2.2 The `poll()` Method

`poll(since)` iterates over every (project, logSource) pair, queries the Management API, parses errors, and returns a flat `ErrorEvent[]`.

```typescript
async poll(since: Date): Promise<ErrorEvent[]> {
  const now = new Date();

  // Clamp to 24h max window
  const earliest = new Date(now.getTime() - MAX_QUERY_WINDOW_MS);
  const effectiveSince = since < earliest ? earliest : since;

  const allEvents: ErrorEvent[] = [];

  for (const project of this.projects) {
    for (const logSource of this.sources) {
      try {
        const events = await this.queryLogSource(
          project.ref,
          project.name,
          logSource,
          effectiveSince,
          now,
        );
        allEvents.push(...events);
      } catch (error) {
        console.warn(
          `[watchdog] Failed to query ${logSource} for ${project.name}: ${error}`,
        );
      }
    }
  }

  return this.applyIgnorePatterns(allEvents);
}
```

---

## 3. Management API Integration

### 3.1 Endpoint

```
GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs.all
```

Query parameters:
- `sql` — BigQuery SQL query against the log source table
- `iso_timestamp_start` — ISO 8601 start time
- `iso_timestamp_end` — ISO 8601 end time

Headers:
- `Authorization: Bearer <access_token>`
- `Content-Type: application/json`

### 3.2 Response Format

```json
{
  "result": [
    {
      "timestamp": 1700000000000000,
      "event_message": "...",
      ...
    }
  ],
  "error": null
}
```

The `result` array contains log rows. Column names depend on the SQL query's `SELECT` clause. The `error` field is `null` on success or a string/object on failure.

### 3.3 API Request Method

```typescript
private async queryApi(
  ref: string,
  sql: string,
  since: Date,
  until: Date,
): Promise<LogRow[]> {
  const url = new URL(
    `${API_BASE}/projects/${ref}/analytics/endpoints/logs.all`,
  );
  url.searchParams.set("sql", sql);
  url.searchParams.set("iso_timestamp_start", since.toISOString());
  url.searchParams.set("iso_timestamp_end", until.toISOString());

  const response = await fetch(url.toString(), {
    headers: {
      "Authorization": `Bearer ${this.accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Management API returned ${response.status}: ${await response.text()}`,
    );
  }

  const body = await response.json() as ApiResponse;

  if (body.error) {
    throw new Error(
      `Management API query error: ${JSON.stringify(body.error)}`,
    );
  }

  return body.result ?? [];
}
```

Type definitions for the raw API response:

```typescript
interface ApiResponse {
  result: LogRow[] | null;
  error: unknown;
}

interface LogRow {
  timestamp: number;       // Unix microseconds
  event_message?: string;
  [key: string]: unknown;  // Columns vary by query
}
```

---

## 4. SQL Queries per Log Source

Each log source has a different schema. The SQL queries are tailored per source to extract error-relevant fields and filter for error-level events. All queries use the `iso_timestamp_start` and `iso_timestamp_end` parameters for time-range filtering (handled by the API, not in the SQL `WHERE`).

### 4.1 Query Builder

```typescript
private buildQuery(logSource: string): string {
  const query = ERROR_QUERIES[logSource];
  if (!query) {
    // Fallback: generic query for unknown sources
    return `select timestamp, event_message from ${logSource} order by timestamp desc limit 100`;
  }
  return query;
}
```

### 4.2 Source-Specific Queries

```typescript
const ERROR_QUERIES: Record<string, string> = {
  edge_logs: `
    select
      timestamp,
      event_message,
      metadata[0].response[0].status_code as status_code,
      metadata[0].request[0].method as method,
      metadata[0].request[0].path as path
    from edge_logs
    cross join unnest(metadata) as metadata
    cross join unnest(metadata.response) as response
    where response.status_code >= {{MIN_STATUS}}
    order by timestamp desc
    limit 200
  `,

  auth_logs: `
    select
      timestamp,
      event_message,
      metadata[0].status as status_code,
      metadata[0].path as path,
      metadata[0].msg as msg
    from auth_logs
    cross join unnest(metadata) as metadata
    where metadata.level in ('error', 'fatal')
       or metadata.status >= {{MIN_STATUS}}
    order by timestamp desc
    limit 200
  `,

  postgres_logs: `
    select
      timestamp,
      event_message,
      metadata[0].parsed[0].error_severity as error_severity,
      metadata[0].parsed[0].sql_state_code as sql_state_code,
      metadata[0].parsed[0].query as query,
      metadata[0].parsed[0].user_name as user_name
    from postgres_logs
    cross join unnest(metadata) as metadata
    cross join unnest(metadata.parsed) as parsed
    where regexp_contains(parsed.error_severity, 'ERROR|FATAL|PANIC')
    order by timestamp desc
    limit 200
  `,

  storage_logs: `
    select
      timestamp,
      event_message,
      metadata[0].statusCode as status_code,
      metadata[0].error as error,
      metadata[0].type as type
    from storage_logs
    cross join unnest(metadata) as metadata
    where metadata.statusCode >= {{MIN_STATUS}}
       or metadata.error is not null
    order by timestamp desc
    limit 200
  `,

  realtime_logs: `
    select
      timestamp,
      event_message,
      metadata[0].level as level
    from realtime_logs
    cross join unnest(metadata) as metadata
    where metadata.level in ('error', 'fatal')
    order by timestamp desc
    limit 200
  `,

  postgrest_logs: `
    select
      timestamp,
      event_message,
      metadata[0].response[0].status_code as status_code
    from postgrest_logs
    cross join unnest(metadata) as metadata
    cross join unnest(metadata.response) as response
    where response.status_code >= {{MIN_STATUS}}
    order by timestamp desc
    limit 200
  `,

  supavisor_logs: `
    select
      timestamp,
      event_message,
      metadata[0].level as level
    from supavisor_logs
    cross join unnest(metadata) as metadata
    where metadata.level in ('error', 'fatal')
    order by timestamp desc
    limit 200
  `,
};
```

The `{{MIN_STATUS}}` placeholder is replaced at runtime with the configured `min_status_code` value:

```typescript
private buildQuery(logSource: string): string {
  const template = ERROR_QUERIES[logSource];
  if (!template) {
    return `select timestamp, event_message from ${logSource} order by timestamp desc limit 100`;
  }
  return template.replaceAll("{{MIN_STATUS}}", String(this.minStatusCode));
}
```

### 4.3 Schema Notes

The Management API uses BigQuery. Key details:

- **Timestamps** are unix microseconds (not milliseconds). Convert with: `new Date(timestamp / 1000)`.
- **Metadata** is an array that requires `cross join unnest()` to access nested fields.
- **Column names** in the response match the `SELECT` aliases (e.g., `status_code`, `error_severity`).
- The `iso_timestamp_start` / `iso_timestamp_end` query parameters handle time-range filtering at the API level, so SQL `WHERE` clauses focus on error detection, not timestamps.

---

## 5. Response Parsing

### 5.1 Log Row to ErrorEvent Mapping

Each log source's response rows are mapped to `ErrorEvent` using a unified parser. The parser is forgiving — missing fields get sensible defaults since log schemas vary and may change.

```typescript
private queryLogSource(
  ref: string,
  projectName: string,
  logSource: string,
  since: Date,
  until: Date,
): Promise<ErrorEvent[]>
```

Implementation:

```typescript
private async queryLogSource(
  ref: string,
  projectName: string,
  logSource: string,
  since: Date,
  until: Date,
): Promise<ErrorEvent[]> {
  const sql = this.buildQuery(logSource);
  const rows = await this.queryApi(ref, sql, since, until);

  return rows.map((row) => this.rowToEvent(row, ref, projectName, logSource));
}

private rowToEvent(
  row: LogRow,
  ref: string,
  projectName: string,
  logSource: string,
): ErrorEvent {
  // Timestamp: API returns unix microseconds
  const ts = typeof row.timestamp === "number"
    ? new Date(row.timestamp / 1000)
    : new Date();

  // Status code: varies by source
  const statusCode = typeof row.status_code === "number"
    ? row.status_code
    : undefined;

  // Message: prefer event_message, fall back to other fields
  const message = row.event_message
    ?? row.msg
    ?? row.error
    ?? row.query
    ?? "Unknown error";

  // Collect remaining fields as metadata
  const { timestamp: _, event_message: __, status_code: ___, ...rest } = row;

  return {
    project: projectName,
    projectRef: ref,
    source: logSource,
    timestamp: ts.toISOString(),
    statusCode,
    message: String(message),
    metadata: Object.keys(rest).length > 0 ? rest : undefined,
  };
}
```

### 5.2 Ignore Pattern Filtering

After collecting all events, apply the configured `ignore_patterns`. A pattern matches if it appears as a case-insensitive substring in the event's `message`:

```typescript
private applyIgnorePatterns(events: ErrorEvent[]): ErrorEvent[] {
  if (this.ignorePatterns.length === 0) return events;

  const lowered = this.ignorePatterns.map((p) => p.toLowerCase());
  return events.filter((event) => {
    const msg = event.message.toLowerCase();
    return !lowered.some((pattern) => msg.includes(pattern));
  });
}
```

---

## 6. Error Handling Strategy

The source must be resilient — a single failing project or log source should not halt the entire poll cycle.

| Failure | Behavior |
|---------|----------|
| Network error (fetch fails) | `console.warn()`, skip this project/source, continue |
| Non-200 HTTP response | `console.warn()` with status and body, skip, continue |
| API returns `{ error: ... }` | `console.warn()` with error details, skip, continue |
| Unexpected response shape | `console.warn()`, return empty array for this source |
| `since` older than 24h | Silently clamp to 24h ago (API limit) |

The warn-and-continue strategy ensures partial results are still delivered. Phase 4's orchestrator will log a summary of failures per poll cycle.

---

## Open Questions

| # | Question | Status | Leaning |
|---|----------|--------|---------|
| 1 | The exact BigQuery metadata schema for each log source is based on Supabase docs and may change (the endpoint is marked experimental). Should the queries be defensive (catch-all columns) or precise (exact column paths)? | Open | Start precise with the documented schemas; add a fallback generic query if a source-specific query fails (retry with `select timestamp, event_message from <source>`). |
| 2 | Should `LIMIT 200` per query be configurable or hardcoded? 200 rows per source per project per poll should be more than enough for error monitoring, but high-traffic projects might legitimately hit this. | Open | Hardcode at 200 for MVP. Can be made configurable later if needed. |
| 3 | Some log sources (e.g., `auth_logs`) may return non-error events that happen to have a high status code. Should the source apply additional heuristics beyond status code filtering? | Open | Trust the SQL WHERE clauses for MVP. Processors can add smarter filtering in future versions. |
