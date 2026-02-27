---
type: phase
domain: mvp
phase: 4
status: done
parent: "[[mvp/plan]]"
depends_on:
  - "[[mvp/phases/phase-2-supabase-source]]"
  - "[[mvp/phases/phase-3-telegram-channel]]"
tags:
  - watchdog/mvp
  - watchdog/phase
---

> [!nav] Navigation
> **Parent:** [[mvp/plan|MVP Implementation Plan]]
> **Spec:** [[mvp/spec|MVP Spec]]
> **Depends on:** [[mvp/phases/phase-2-supabase-source|Phase 2: Supabase Source]], [[mvp/phases/phase-3-telegram-channel|Phase 3: Telegram Channel]]
> **Prev:** [[mvp/phases/phase-3-telegram-channel|Phase 3: Telegram Channel]]
> **Next:** [[mvp/phases/phase-5-bot-commands|Phase 5: Bot Commands]]


# Watchdog — Phase 4: Orchestration

## Context

```
vision-spec
  └── mvp/spec
        └── mvp/plan
              Phase 1: Foundation & Config  ✓
              Phase 2: Supabase Source      ✓
              Phase 3: Telegram Channel     ✓
              ► Phase 4: Orchestration (this document)
              Phase 5: Bot Commands
              Phase 6: Deployment & Docs
```

Supabase Watchdog is a lightweight error monitoring tool that polls the Supabase Management API for error-level events and delivers alerts to notification channels. This phase wires all the existing pieces together into a running application.

Phase 1 built the foundation (`deno.json`, `types.ts`, `config.ts` with `loadConfig()` and `parseDuration()`). Phase 2 built the `SupabaseSource` that queries the Management API and returns `ErrorEvent[]`. Phase 3 built the `PassthroughProcessor` (no-op transform) and `TelegramChannel` (formats and sends alerts via the Telegram Bot API). All three plugin layers exist with working implementations, but nothing ties them together — there is no entry point, no scheduling, and no deduplication.

This phase creates `main.ts`, the entry point that loads config, instantiates the source/processor/channel, sets up `Deno.cron()` for periodic polling, implements within-window deduplication, and runs the complete pipeline: `Source.poll()` → deduplicate → `Processor.process()` → `Channel.send()`. After this phase, Watchdog is a running application that can be started with `deno task start` and will poll for errors and send Telegram alerts on a schedule.

Phase 5 (Bot Commands) extends the Telegram channel with interactive commands (`/check`, `/errors`, `/status`). Phase 6 (Deployment & Docs) adds Dockerfile, README, and deployment artifacts. Do not build bot command handling or deployment artifacts here.

---

## Scope Boundaries

### This phase DOES:

- Create `main.ts` as the application entry point
- Load config via `loadConfig()` and instantiate `SupabaseSource`, `PassthroughProcessor`, and `TelegramChannel`
- Set up `Deno.cron()` with the configured polling interval to trigger the pipeline periodically
- Implement the core pipeline function: poll → deduplicate → process → send
- Track `lastPollTime` in memory to define the polling window for each cycle
- Deduplicate events within a polling window by hashing `(projectRef, source, message)`
- Log pipeline activity to console (poll start, event counts, errors, send completion)
- Handle top-level errors gracefully so a single failed cycle does not crash the process

### This phase does NOT:

- Implement bot command handling (`/check`, `/errors`, `/status`) — Phase 5
- Register Telegram bot commands or set up update polling/webhooks — Phase 5
- Create `Dockerfile` or deployment artifacts — Phase 6
- Create `README.md` — Phase 6
- Persist state across restarts (last poll time, error history) — future smarts domain
- Implement cross-window deduplication (suppressing recurring known errors) — future smarts domain
- Add any new dependencies — everything needed is already available

### Boundary details:

- `lastPollTime` is held in memory and initialised to "now" on startup. This means the first poll after a restart will not catch errors from while the process was down. This is acceptable for the MVP — persistent state belongs to the smarts domain.
- Deduplication is per-window only. If the same error appears in two consecutive poll cycles, it will be alerted twice. Cross-window dedup is out of scope.
- `Deno.cron()` uses cron expression syntax, not a millisecond interval. The `parseDuration()` result must be converted to a cron schedule. For simplicity, the MVP supports minute-level granularity only (e.g., `"5m"` → `"*/5 * * * *"`).
- Phase 5 will need access to the pipeline function and the source instance to trigger on-demand polls. `main.ts` should expose or structure these so Phase 5 can hook in without major refactoring.

---

## Project Integration

This phase creates the single entry point that `deno.json` tasks already reference (`main.ts`). It imports from all existing modules: `config.ts`, `sources/mod.ts`, `processors/mod.ts`, and `channels/mod.ts`. No existing files are modified.

### Files modified

No existing files modified.

### New files

```
main.ts   ← Entry point: config loading, plugin init, cron scheduling, pipeline orchestration
```

### Dependencies to add

No new dependencies.

---

## 1. Entry Point Structure

`main.ts` has a clear top-to-bottom flow: load config → init plugins → define pipeline → start cron → log startup.

```typescript
import { loadConfig, parseDuration } from "./config.ts";
import { SupabaseSource } from "./sources/mod.ts";
import { PassthroughProcessor } from "./processors/mod.ts";
import { TelegramChannel } from "./channels/mod.ts";
import type { ErrorEvent } from "./types.ts";

const config = await loadConfig();

const source = new SupabaseSource(config);
const processor = new PassthroughProcessor();
const channel = new TelegramChannel(config);

let lastPollTime = new Date();

console.log(
  `[watchdog] Started — monitoring ${config.projects.length} project(s), polling every ${config.polling.interval}`,
);
```

---

## 2. Core Pipeline Function

The pipeline function runs one complete poll cycle. It is called both by the cron job and (in Phase 5) by on-demand bot commands.

```typescript
async function runPollCycle(): Promise<void> {
  const cycleStart = new Date();
  console.log(`[watchdog] Poll cycle started at ${cycleStart.toISOString()}`);

  try {
    // 1. Poll
    const events = await source.poll(lastPollTime);
    console.log(`[watchdog] Polled ${events.length} error(s)`);

    // 2. Deduplicate
    const unique = deduplicateEvents(events);
    if (unique.length < events.length) {
      console.log(
        `[watchdog] Deduplicated: ${events.length} → ${unique.length} event(s)`,
      );
    }

    // 3. Process
    const processed = await processor.process(unique);

    // 4. Send
    if (processed.length > 0) {
      await channel.send(processed);
      console.log(`[watchdog] Sent ${processed.length} alert(s)`);
    } else {
      console.log(`[watchdog] No errors found`);
    }
  } catch (error) {
    console.error(`[watchdog] Poll cycle failed: ${error}`);
  }

  lastPollTime = cycleStart;
}
```

Key design points:
- `lastPollTime` is updated to `cycleStart` (not "now") after the cycle completes. This ensures the next window starts from when this cycle's query began, not when it finished — no gap between windows.
- The `try/catch` wraps the entire cycle so a failure in any step (source, processor, or channel) does not crash the process.
- `lastPollTime` is still updated even if the cycle fails, to avoid querying an ever-growing window on repeated failures.

---

## 3. Within-Window Deduplication

The same error can appear multiple times within a single poll response (e.g., a failing edge function hit 50 times in 5 minutes). Deduplicate by hashing `(projectRef, source, message)`:

```typescript
function deduplicateEvents(events: ErrorEvent[]): ErrorEvent[] {
  const seen = new Set<string>();
  const unique: ErrorEvent[] = [];

  for (const event of events) {
    const key = `${event.projectRef}:${event.source}:${event.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(event);
    }
  }

  return unique;
}
```

The dedup key is a simple string concatenation — no hash function needed. The first occurrence of each unique error is kept; duplicates are silently dropped.

---

## 4. Cron Scheduling

`Deno.cron()` expects a cron expression string and a handler function. The configured polling interval (e.g., `"5m"`) must be converted to a cron expression.

### 4.1 Duration to Cron Conversion

For MVP, only minute-level granularity is supported. The polling interval from config is parsed to milliseconds via `parseDuration()`, then converted to minutes for the cron expression:

```typescript
function intervalToCron(interval: string): string {
  const ms = parseDuration(interval);
  const minutes = Math.round(ms / 60_000);

  if (minutes < 1) {
    throw new Error("Polling interval must be at least 1 minute");
  }

  if (minutes < 60) {
    // Every N minutes: */N * * * *
    return `*/${minutes} * * * *`;
  }

  // Hourly or more: convert to hours
  const hours = Math.round(minutes / 60);
  return `0 */${hours} * * *`;
}
```

### 4.2 Cron Setup

```typescript
const cronExpression = intervalToCron(config.polling.interval);

Deno.cron("watchdog-poll", cronExpression, async () => {
  await runPollCycle();
});

console.log(`[watchdog] Cron scheduled: ${cronExpression}`);
```

---

## 5. Console Logging

All log output uses a `[watchdog]` prefix for easy identification. Log levels follow a simple convention:

| Level | Method | When |
|-------|--------|------|
| Info | `console.log` | Startup, poll start, event counts, send completion |
| Warning | `console.warn` | Non-fatal issues (already handled by source/channel internally) |
| Error | `console.error` | Poll cycle failures (caught by try/catch) |

Example output for a typical cycle:

```
[watchdog] Started — monitoring 2 project(s), polling every 5m
[watchdog] Cron scheduled: */5 * * * *
[watchdog] Poll cycle started at 2026-02-27T14:30:00.000Z
[watchdog] Polled 8 error(s)
[watchdog] Deduplicated: 8 → 3 event(s)
[watchdog] Sent 3 alert(s)
```

Example for a clean cycle:

```
[watchdog] Poll cycle started at 2026-02-27T14:35:00.000Z
[watchdog] Polled 0 error(s)
[watchdog] No errors found
```

---

## 6. Phase 5 Integration Considerations

Phase 5 will add bot commands that need to:

1. Trigger `runPollCycle()` on demand (for `/check`)
2. Access the `source` instance directly (for `/errors <timeframe>` which polls with a custom `since`)
3. Read `lastPollTime` and `config.projects` (for `/status`)

To support this without refactoring, `main.ts` should keep `runPollCycle`, `source`, `lastPollTime`, and `config` accessible at module scope (not buried inside closures). Phase 5 will either extend `main.ts` directly or extract shared state into a small module — that decision belongs to Phase 5's brief.

---

## Open Questions

| # | Question | Status | Leaning |
|---|----------|--------|---------|
| 1 | Should `main.ts` run an initial poll immediately on startup, or wait for the first cron tick? | Open | Run immediately — the user wants to know it works right away. Add an initial `await runPollCycle()` after cron setup. |
| 2 | Should the `intervalToCron` conversion handle edge cases like `"90m"` (= `"*/90 * * * *"` which cron doesn't support) by falling back to the nearest hour? | Open | For MVP, reject intervals that don't map cleanly to cron. Supported: 1m–59m (minute intervals) and multiples of 60m (hourly intervals). Anything else throws a config validation error. |
| 3 | Should `deduplicateEvents` preserve the first or last occurrence of duplicate events? The first has the earliest timestamp; the last has the most recent. | Open | Keep first — it represents when the error originally appeared in the window. |
