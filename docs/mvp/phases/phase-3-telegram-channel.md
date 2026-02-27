---
type: phase
domain: mvp
phase: 3
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
> **Prev:** [[mvp/phases/phase-2-supabase-source|Phase 2: Supabase Source]]
> **Next:** [[mvp/phases/phase-4-orchestration|Phase 4: Orchestration]]


# Watchdog — Phase 3: Telegram Channel & Passthrough Processor

## Context

```
vision-spec
  └── mvp/spec
        └── mvp/plan
              Phase 1: Foundation & Config  ✓
              Phase 2: Supabase Source      ✓
              ► Phase 3: Telegram Channel (this document)
              Phase 4: Orchestration
              Phase 5: Bot Commands
              Phase 6: Deployment & Docs
```

Supabase Watchdog is a lightweight error monitoring tool that polls the Supabase Management API for error-level events and delivers alerts to notification channels. This phase builds the delivery side of the pipeline — the Telegram channel and the passthrough processor.

Phase 1 established the foundation: `deno.json`, `types.ts` (all interfaces), `config.ts` (YAML loading, env interpolation, validation, `parseDuration()`), and the example config. Phase 2 built the `SupabaseSource` that queries the Management API and returns `ErrorEvent[]`. The project can now load config and fetch errors, but has no way to transform or deliver them.

This phase creates four files: `processors/mod.ts` and `processors/passthrough.ts` (the MVP processor that passes events through unchanged as `ProcessedEvent[]`), plus `channels/mod.ts` and `channels/telegram.ts` (the Telegram alert sender that formats processed events into readable messages and sends them via the Telegram Bot API). After this phase, all three plugin layers have at least one implementation, and the pipeline is ready to be wired together.

Phase 4 (Orchestration) wires source → processor → channel into a running `Deno.cron()` pipeline. Phase 5 adds interactive bot commands (`/check`, `/errors`, `/status`). Do not build any orchestration, scheduling, or bot command handling here — this phase only handles outbound alert delivery.

---

## Scope Boundaries

### This phase DOES:

- Create `processors/mod.ts` as a barrel re-exporting the `Processor` interface and `PassthroughProcessor`
- Create `processors/passthrough.ts` implementing the `Processor` interface — maps `ErrorEvent[]` to `ProcessedEvent[]` with no transformation
- Create `channels/mod.ts` as a barrel re-exporting the `Channel` interface and `TelegramChannel`
- Create `channels/telegram.ts` implementing the `Channel` interface with a `send()` method
- Format `ProcessedEvent[]` into human-readable Telegram messages using HTML parse mode
- Respect the 4096-character Telegram message limit with truncation
- Enforce the `max_alerts_per_interval` cap from config
- Implement rate-aware sending with delays between messages (20 msg/min to same chat)

### This phase does NOT:

- Implement bot command handling (`/check`, `/errors`, `/status`) — Phase 5
- Register any bot commands or set up webhook/polling for incoming messages — Phase 5
- Create `main.ts` or any entry point — Phase 4
- Set up `Deno.cron()` or any scheduling — Phase 4
- Implement deduplication — Phase 4
- Call `Source.poll()` or orchestrate the pipeline — Phase 4
- Add any Telegram bot library dependency — raw `fetch()` against the Bot API is sufficient for sending messages

### Boundary details:

- The `TelegramChannel` constructor takes a `WatchdogConfig` and extracts the Telegram config (`bot_token`, `chat_id`) and filter config (`max_alerts_per_interval`). It does not own the config lifecycle.
- `send()` receives already-processed, already-deduplicated events. It only formats and delivers — no filtering logic beyond the alert cap.
- The `registerCommands()` method on the `Channel` interface is left as a no-op stub in this phase. Phase 5 will implement it.
- No Telegram bot library is needed. The MVP only sends messages (one-way) via `POST https://api.telegram.org/bot<token>/sendMessage`. Bot command polling/webhooks are added in Phase 5.

---

## Project Integration

This phase adds two new plugin module directories (`processors/`, `channels/`) alongside the existing `sources/` directory. It imports `ErrorEvent`, `ProcessedEvent`, `Processor`, `Channel`, and config types from `types.ts`. No existing files are modified.

### Files modified

No existing files modified.

### New files

```
processors/mod.ts          ← Barrel: re-exports Processor interface + PassthroughProcessor
processors/passthrough.ts  ← Passthrough processor (events → processed events, no-op)
channels/mod.ts            ← Barrel: re-exports Channel interface + TelegramChannel
channels/telegram.ts       ← Telegram alert sender via Bot API
```

### Dependencies to add

No new dependencies. Telegram Bot API is called with `fetch()` (built into Deno).

---

## 1. Passthrough Processor

### 1.1 Registry Module

`processors/mod.ts`:

```typescript
export type { Processor } from "../types.ts";
export { PassthroughProcessor } from "./passthrough.ts";
```

### 1.2 PassthroughProcessor

`processors/passthrough.ts` implements the `Processor` interface. It maps each `ErrorEvent` to a `ProcessedEvent` with no enrichment — the added fields (`analysis`, `severity`, `suggestedAction`) remain `undefined`.

```typescript
import type { ErrorEvent, ProcessedEvent, Processor } from "../types.ts";

export class PassthroughProcessor implements Processor {
  readonly name = "passthrough";

  async process(events: ErrorEvent[]): Promise<ProcessedEvent[]> {
    return events.map((event) => ({ ...event }));
  }
}
```

The `async` is kept for interface compliance even though the implementation is synchronous. The spread creates a shallow copy so downstream mutations don't affect the original events.

---

## 2. Channel Registry Module

`channels/mod.ts`:

```typescript
export type { Channel } from "../types.ts";
export { TelegramChannel } from "./telegram.ts";
```

---

## 3. TelegramChannel Class

### 3.1 Class Structure

```typescript
import type { Channel, ProcessedEvent, WatchdogConfig } from "../types.ts";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4096;
const RATE_LIMIT_DELAY_MS = 3000; // ~20 msg/min = 1 msg per 3s

export class TelegramChannel implements Channel {
  readonly name = "telegram";

  private botToken: string;
  private chatId: string;
  private maxAlerts: number;

  constructor(config: WatchdogConfig) {
    const telegram = config.channels.telegram;
    if (!telegram) {
      throw new Error("Telegram channel config is missing");
    }
    this.botToken = telegram.bot_token;
    this.chatId = telegram.chat_id;
    this.maxAlerts = config.filters.max_alerts_per_interval;
  }

  async send(events: ProcessedEvent[]): Promise<void> { ... }

  registerCommands(): void {
    // No-op stub. Phase 5 implements bot command handling.
  }
}
```

### 3.2 The `send()` Method

`send()` formats and delivers events to Telegram, respecting the alert cap and rate limits.

```typescript
async send(events: ProcessedEvent[]): Promise<void> {
  if (events.length === 0) return;

  // Enforce alert cap
  const capped = events.slice(0, this.maxAlerts);
  const dropped = events.length - capped.length;

  for (let i = 0; i < capped.length; i++) {
    const message = this.formatEvent(capped[i]!);
    await this.sendMessage(message);

    // Rate limiting: wait between messages (except after the last one)
    if (i < capped.length - 1) {
      await delay(RATE_LIMIT_DELAY_MS);
    }
  }

  // If events were dropped, send a summary message
  if (dropped > 0) {
    await delay(RATE_LIMIT_DELAY_MS);
    await this.sendMessage(
      `⚠️ <b>${dropped} additional alert(s)</b> were suppressed (max ${this.maxAlerts} per interval).`,
    );
  }
}
```

A simple delay helper:

```typescript
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

---

## 4. Message Formatting

### 4.1 Alert Format

Each event is formatted as an HTML message for Telegram. HTML parse mode is used because it's more predictable than Markdown (no issues with underscores in log messages).

```typescript
private formatEvent(event: ProcessedEvent): string {
  const lines: string[] = [];

  // Header with project name
  lines.push(`🚨 <b>Error in ${escapeHtml(event.project)}</b>`);
  lines.push("");

  // Source
  lines.push(`<b>Source:</b> ${escapeHtml(event.source)}`);

  // Status code (if present)
  if (event.statusCode !== undefined) {
    lines.push(`<b>Status:</b> ${event.statusCode}`);
  }

  // Timestamp
  lines.push(`<b>Time:</b> ${escapeHtml(event.timestamp)}`);

  // Severity (if set by processor)
  if (event.severity) {
    lines.push(`<b>Severity:</b> ${escapeHtml(event.severity)}`);
  }

  // Error message — this can be long, so it goes last
  lines.push("");
  lines.push(`<pre>${escapeHtml(event.message)}</pre>`);

  let text = lines.join("\n");

  // Truncate if exceeding Telegram limit
  if (text.length > MAX_MESSAGE_LENGTH) {
    const suffix = "\n\n... (truncated)";
    text = text.substring(0, MAX_MESSAGE_LENGTH - suffix.length) + suffix;
  }

  return text;
}
```

### 4.2 HTML Escaping

Telegram HTML mode requires escaping `<`, `>`, and `&` in user-provided content to prevent broken formatting:

```typescript
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
```

Order matters — `&` must be escaped first to avoid double-escaping.

---

## 5. Telegram Bot API Integration

### 5.1 sendMessage Endpoint

```
POST https://api.telegram.org/bot<token>/sendMessage
Content-Type: application/json

{
  "chat_id": "<chat_id>",
  "text": "<message>",
  "parse_mode": "HTML"
}
```

### 5.2 Implementation

```typescript
private async sendMessage(text: string): Promise<void> {
  const url = `${TELEGRAM_API}/bot${this.botToken}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: this.chatId,
      text,
      parse_mode: "HTML",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.warn(
      `[watchdog] Telegram sendMessage failed (${response.status}): ${body}`,
    );
  }
}
```

### 5.3 Error Handling

| Failure | Behavior |
|---------|----------|
| Network error (fetch fails) | Exception propagates up; Phase 4's orchestrator catches and logs |
| Non-200 response (rate limited, bad token, etc.) | `console.warn()` with status and body, continues to next message |
| Message too long after formatting | Truncated before sending (handled in `formatEvent`) |
| Telegram 429 (Too Many Requests) | Logged as warning; the 3s delay between messages should prevent this in practice |

---

## 6. Example Output

For an edge_logs error event, the Telegram message would look like:

```
🚨 Error in creoby-prod

Source: edge_logs
Status: 500
Time: 2026-02-27T14:30:00.000Z

ReferenceError: someVar is not defined
    at handleRequest (file:///src/functions/api/index.ts:42:5)
```

For a postgres_logs error:

```
🚨 Error in creoby-prod

Source: postgres_logs
Time: 2026-02-27T14:30:00.000Z

ERROR: relation "nonexistent_table" does not exist at character 15
```

---

## Open Questions

| # | Question | Status | Leaning |
|---|----------|--------|---------|
| 1 | Should multiple events be batched into a single Telegram message (one message with N errors) or sent as individual messages (N messages with 1 error each)? | Open | Individual messages for MVP — easier to read, link to, and react to. Batching is a future optimization if rate limits become a problem. |
| 2 | Should the rate limit delay be adaptive (check Telegram's `retry_after` header on 429 responses) or fixed at 3 seconds? | Open | Fixed for MVP. Adaptive retry is a nice-to-have for the smarts domain. |
| 3 | Should the `send()` method return information about delivery success/failure (e.g., count of successfully sent messages) or remain `Promise<void>`? | Open | Keep `Promise<void>` per the interface. Delivery tracking can be added as a metric/logging concern later without changing the interface. |
