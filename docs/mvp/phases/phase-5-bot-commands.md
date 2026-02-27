---
type: phase
domain: mvp
phase: 5
status: done
parent: "[[mvp/plan]]"
depends_on:
  - "[[mvp/phases/phase-4-orchestration]]"
tags:
  - watchdog/mvp
  - watchdog/phase
---

> [!nav] Navigation
> **Parent:** [[mvp/plan|MVP Implementation Plan]]
> **Spec:** [[mvp/spec|MVP Spec]]
> **Depends on:** [[mvp/phases/phase-4-orchestration|Phase 4: Orchestration]]
> **Prev:** [[mvp/phases/phase-4-orchestration|Phase 4: Orchestration]]
> **Next:** [[mvp/phases/phase-6-deployment|Phase 6: Deployment & Docs]]


# Watchdog — Phase 5: Bot Commands

## Context

```
vision-spec
  └── mvp/spec
        └── mvp/plan
              Phase 1: Foundation & Config  ✓
              Phase 2: Supabase Source      ✓
              Phase 3: Telegram Channel     ✓
              Phase 4: Orchestration        ✓
              ► Phase 5: Bot Commands (this document)
              Phase 6: Deployment & Docs
```

Supabase Watchdog is a lightweight error monitoring tool that polls the Supabase Management API for error-level events and delivers alerts to notification channels. This phase adds interactive Telegram bot commands so developers can query errors on demand, not just passively receive scheduled alerts.

Phase 1 built the foundation (types, config, parseDuration). Phase 2 built the `SupabaseSource` (Management API poller). Phase 3 built the `PassthroughProcessor` and `TelegramChannel` (outbound alert sending via Bot API). Phase 4 built `main.ts` — the entry point that wires source → processor → channel into a `Deno.cron()` pipeline with deduplication. The application runs, polls on schedule, and sends alerts. But it's one-way — users cannot interact with it.

This phase extends `channels/telegram.ts` with a long-polling loop that listens for incoming Telegram messages and dispatches bot commands (`/check`, `/check <project>`, `/errors <timeframe>`, `/status`). It also updates `main.ts` to initialize the bot polling on startup and pass the shared state (source, config, lastPollTime) that commands need. After this phase, Watchdog is a fully interactive monitoring tool — scheduled alerts plus on-demand queries.

Phase 6 (Deployment & Docs) adds Dockerfile, README, and deployment artifacts. Do not build deployment infrastructure here.

---

## Scope Boundaries

### This phase DOES:

- Add a `startPolling()` method to `TelegramChannel` that long-polls the Telegram `getUpdates` API for incoming messages
- Implement command dispatching: parse incoming messages for `/check`, `/errors`, `/status` and route to handlers
- Implement `/check` — trigger a full poll cycle across all projects, send results to chat
- Implement `/check <project>` — poll a specific project by name or ref, send results
- Implement `/errors <timeframe>` — query the source for errors in the last N minutes/hours, send results
- Implement `/status` — report last poll time, number of projects, monitoring status
- Update `main.ts` to call `startPolling()` on startup, passing required dependencies (source, config, lastPollTime accessor)
- Handle unknown commands gracefully with a help message

### This phase does NOT:

- Use Telegram webhooks — long-polling via `getUpdates` is simpler and works everywhere without a public URL
- Add a Telegram bot library — raw `fetch()` against the Bot API is sufficient
- Create `Dockerfile` or deployment artifacts — Phase 6
- Create `README.md` — Phase 6
- Implement any new notification channels — future channels domain
- Add persistent state or error history — future smarts domain

### Boundary details:

- The bot polling loop runs independently of the cron pipeline. They share the `source` instance for on-demand queries but don't interfere with each other.
- `/check` reuses the existing `runPollCycle` flow from `main.ts` but sends results back to the requesting chat rather than using the configured `chat_id`. For the MVP, since only one chat is configured, results go to `this.chatId`.
- `/errors <timeframe>` calls `source.poll()` directly with a computed `since` date. It bypasses the processor/channel pipeline and formats results inline — this is an on-demand query, not a pipeline cycle.
- The bot needs access to shared state from `main.ts`. Rather than exporting globals, this phase introduces a `BotDeps` interface that `main.ts` passes to `startPolling()`. This keeps the dependency direction clean: `main.ts` → `TelegramChannel`, not the reverse.

---

## Project Integration

This phase modifies two existing files: `channels/telegram.ts` (add polling loop and command handlers) and `main.ts` (initialize bot polling on startup). The patterns follow existing conventions — `fetch()` for Telegram API calls, `console.log/warn` for logging, `escapeHtml()` for message formatting.

### Files modified

```
channels/telegram.ts  ← Add startPolling(), command handlers, getUpdates loop
main.ts               ← Call channel.startPolling() with dependencies after cron setup
```

### New files

No new files.

### Dependencies to add

No new dependencies.

---

## 1. Bot Dependencies Interface

Commands need access to shared state from `main.ts`. Define a dependency interface that `main.ts` passes when starting the bot:

```typescript
// Add to channels/telegram.ts

export interface BotDeps {
  /** The source instance for on-demand polling. */
  source: Source;
  /** The processor instance for processing events. */
  processor: Processor;
  /** Accessor for the current lastPollTime. */
  getLastPollTime: () => Date;
  /** The loaded config for project info. */
  config: WatchdogConfig;
}
```

Import the additional types needed:

```typescript
import type {
  Channel,
  ErrorEvent,
  ProcessedEvent,
  Processor,
  Source,
  WatchdogConfig,
} from "../types.ts";
import { parseDuration } from "../config.ts";
```

---

## 2. Telegram getUpdates Polling

### 2.1 The `startPolling()` Method

Add to `TelegramChannel`:

```typescript
private deps: BotDeps | null = null;
private updateOffset = 0;

startPolling(deps: BotDeps): void {
  this.deps = deps;
  this.pollUpdates();
  console.log("[watchdog] Telegram bot polling started");
}
```

### 2.2 Long-Polling Loop

`getUpdates` with a `timeout` parameter enables long-polling — the request blocks server-side until an update arrives or the timeout elapses:

```typescript
private async pollUpdates(): Promise<void> {
  while (true) {
    try {
      const updates = await this.getUpdates();
      for (const update of updates) {
        this.updateOffset = update.update_id + 1;
        if (update.message?.text) {
          await this.handleCommand(update.message);
        }
      }
    } catch (error) {
      console.warn(`[watchdog] Bot polling error: ${error}`);
      await delay(5000); // Back off on errors
    }
  }
}

private async getUpdates(): Promise<TelegramUpdate[]> {
  const url = `${TELEGRAM_API}/bot${this.botToken}/getUpdates`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      offset: this.updateOffset,
      timeout: 30,
      allowed_updates: ["message"],
    }),
  });

  if (!response.ok) {
    throw new Error(`getUpdates failed (${response.status})`);
  }

  const body = await response.json() as { ok: boolean; result: TelegramUpdate[] };
  return body.result ?? [];
}
```

### 2.3 Telegram Types

Minimal type definitions for the update objects — only what the bot needs:

```typescript
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
}
```

---

## 3. Command Dispatcher

Parse the incoming message text and route to the appropriate handler:

```typescript
private async handleCommand(message: TelegramMessage): Promise<void> {
  const text = message.text?.trim() ?? "";
  const chatId = String(message.chat.id);

  // Only respond to commands (starting with /)
  if (!text.startsWith("/")) return;

  const [command, ...args] = text.split(/\s+/);

  try {
    switch (command) {
      case "/check":
        await this.handleCheck(chatId, args);
        break;
      case "/errors":
        await this.handleErrors(chatId, args);
        break;
      case "/status":
        await this.handleStatus(chatId);
        break;
      case "/start":
      case "/help":
        await this.handleHelp(chatId);
        break;
      default:
        await this.sendMessageTo(
          chatId,
          `Unknown command: <code>${escapeHtml(command!)}</code>\nType /help for available commands.`,
        );
    }
  } catch (error) {
    console.error(`[watchdog] Command ${command} failed: ${error}`);
    await this.sendMessageTo(chatId, `❌ Command failed: ${escapeHtml(String(error))}`);
  }
}
```

---

## 4. Command Handlers

### 4.1 `/check` — Poll All Projects

Triggers an on-demand poll across all projects (or a specific one), deduplicates, processes, and sends results to the requesting chat.

```typescript
private async handleCheck(chatId: string, args: string[]): Promise<void> {
  const deps = this.deps!;
  const projectFilter = args.join(" ").trim() || null;

  await this.sendMessageTo(chatId, "🔍 Checking for errors...");

  const since = deps.getLastPollTime();
  const events = await deps.source.poll(since);

  // Filter to specific project if requested
  let filtered = events;
  if (projectFilter) {
    const lower = projectFilter.toLowerCase();
    filtered = events.filter(
      (e) =>
        e.project.toLowerCase() === lower ||
        e.projectRef.toLowerCase() === lower,
    );

    if (filtered.length === 0 && events.length > 0) {
      // Check if the project name/ref was valid
      const known = deps.config.projects.some(
        (p) =>
          p.name.toLowerCase() === lower ||
          p.ref.toLowerCase() === lower,
      );
      if (!known) {
        await this.sendMessageTo(
          chatId,
          `❓ Unknown project: <code>${escapeHtml(projectFilter)}</code>\n\nKnown projects:\n${deps.config.projects.map((p) => `• ${escapeHtml(p.name)} (<code>${p.ref}</code>)`).join("\n")}`,
        );
        return;
      }
    }
  }

  if (filtered.length === 0) {
    const scope = projectFilter ? `for ${projectFilter}` : "across all projects";
    await this.sendMessageTo(chatId, `✅ No errors found ${scope}.`);
    return;
  }

  // Deduplicate, process, and send
  const unique = this.deduplicateEvents(filtered);
  const processed = await deps.processor.process(unique);
  await this.sendEventsToChat(chatId, processed);
}
```

Note: The `deduplicateEvents` function from `main.ts` is duplicated here as a private method (same logic: key on `projectRef:source:message`). Extracting it to a shared utility is a minor refactor that can be done in Phase 6 if desired, but for now keeping it self-contained avoids changing `main.ts`'s module structure.

### 4.2 `/errors <timeframe>` — Query Recent Errors

Queries the source with a custom time window. Uses `parseDuration()` from `config.ts` to parse the timeframe argument.

```typescript
private async handleErrors(chatId: string, args: string[]): Promise<void> {
  const deps = this.deps!;
  const timeframeArg = args[0];

  if (!timeframeArg) {
    await this.sendMessageTo(
      chatId,
      "Usage: <code>/errors &lt;timeframe&gt;</code>\nExamples: <code>/errors 30m</code>, <code>/errors 2h</code>",
    );
    return;
  }

  let durationMs: number;
  try {
    durationMs = parseDuration(timeframeArg);
  } catch {
    await this.sendMessageTo(
      chatId,
      `❌ Invalid timeframe: <code>${escapeHtml(timeframeArg)}</code>\nExamples: <code>30m</code>, <code>2h</code>, <code>1h30m</code>`,
    );
    return;
  }

  await this.sendMessageTo(chatId, `🔍 Fetching errors from the last ${escapeHtml(timeframeArg)}...`);

  const since = new Date(Date.now() - durationMs);
  const events = await deps.source.poll(since);

  if (events.length === 0) {
    await this.sendMessageTo(chatId, `✅ No errors in the last ${escapeHtml(timeframeArg)}.`);
    return;
  }

  const unique = this.deduplicateEvents(events);
  const processed = await deps.processor.process(unique);
  await this.sendEventsToChat(chatId, processed);
}
```

### 4.3 `/status` — Monitoring Status

Reports current monitoring state:

```typescript
private async handleStatus(chatId: string): Promise<void> {
  const deps = this.deps!;
  const lastPoll = deps.getLastPollTime();
  const projects = deps.config.projects;
  const sources = deps.config.polling.sources;

  const lines = [
    "📊 <b>Watchdog Status</b>",
    "",
    `<b>Projects:</b> ${projects.length}`,
    ...projects.map((p) => `  • ${escapeHtml(p.name)} (<code>${p.ref}</code>)`),
    "",
    `<b>Log sources:</b> ${sources.length}`,
    `<b>Polling interval:</b> ${escapeHtml(deps.config.polling.interval)}`,
    `<b>Last poll:</b> ${lastPoll.toISOString()}`,
  ];

  await this.sendMessageTo(chatId, lines.join("\n"));
}
```

### 4.4 `/help` — Available Commands

```typescript
private async handleHelp(chatId: string): Promise<void> {
  const lines = [
    "🐕 <b>Watchdog Commands</b>",
    "",
    "<code>/check</code> — Poll all projects for errors now",
    "<code>/check &lt;project&gt;</code> — Poll a specific project",
    "<code>/errors &lt;timeframe&gt;</code> — Errors from last N minutes/hours",
    "<code>/status</code> — Show monitoring status",
    "<code>/help</code> — Show this message",
  ];

  await this.sendMessageTo(chatId, lines.join("\n"));
}
```

---

## 5. Helper Methods

### 5.1 Send to Arbitrary Chat

The existing `sendMessage()` always sends to `this.chatId`. Commands may respond to the chat that sent the command (which is `this.chatId` in practice for the MVP, but keeping it parameterised is cleaner). Add a `sendMessageTo()` method:

```typescript
private async sendMessageTo(chatId: string, text: string): Promise<void> {
  const url = `${TELEGRAM_API}/bot${this.botToken}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
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

The existing `sendMessage(text)` can be refactored to call `sendMessageTo(this.chatId, text)` to avoid duplication.

### 5.2 Send Events to Chat

Formats and sends a list of processed events to a specific chat, reusing the existing `formatEvent()` method. Respects the same rate limiting as scheduled alerts:

```typescript
private async sendEventsToChat(
  chatId: string,
  events: ProcessedEvent[],
): Promise<void> {
  const capped = events.slice(0, this.maxAlerts);
  const dropped = events.length - capped.length;

  for (let i = 0; i < capped.length; i++) {
    const message = this.formatEvent(capped[i]!);
    await this.sendMessageTo(chatId, message);
    if (i < capped.length - 1) {
      await delay(RATE_LIMIT_DELAY_MS);
    }
  }

  if (dropped > 0) {
    await delay(RATE_LIMIT_DELAY_MS);
    await this.sendMessageTo(
      chatId,
      `⚠️ <b>${dropped} additional error(s)</b> not shown (max ${this.maxAlerts} per request).`,
    );
  }
}
```

### 5.3 Deduplication (Private Copy)

Same logic as `main.ts`'s `deduplicateEvents`, kept as a private method:

```typescript
private deduplicateEvents(events: ErrorEvent[]): ErrorEvent[] {
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

---

## 6. main.ts Changes

Add bot initialization after the cron setup and initial poll:

```typescript
// --- Bot polling ---

channel.startPolling({
  source,
  processor,
  getLastPollTime: () => lastPollTime,
  config,
});
```

This passes the shared state to the bot via the `BotDeps` interface. The `getLastPollTime` accessor provides a live reference (reads the current `lastPollTime` value at call time, not a snapshot).

The full startup sequence becomes:
1. Load config
2. Init plugins
3. Set up cron
4. Run initial poll
5. Start bot polling

---

## 7. Error Handling

| Failure | Behavior |
|---------|----------|
| `getUpdates` network error | `console.warn()`, 5s backoff, retry |
| `getUpdates` non-200 response | Throw, caught by polling loop, 5s backoff |
| Command handler throws | `console.error()`, send error message to chat, continue polling |
| Invalid `/errors` timeframe | Reply with usage hint, don't throw |
| Unknown project in `/check` | Reply with known projects list, don't throw |
| Source fails during on-demand poll | Error propagates to command handler catch, user sees error message |

---

## Open Questions

| # | Question | Status | Leaning |
|---|----------|--------|---------|
| 1 | Should the bot restrict commands to the configured `chat_id` only, or respond to any chat that messages it? | Open | Respond to any chat for MVP — the bot token is private, so only people who know it can message the bot. Authorization can be added later. |
| 2 | Should `/check` trigger `runPollCycle()` from main (which also updates `lastPollTime`) or do its own independent poll (which doesn't affect the cron schedule)? | Open | Independent poll — `/check` is a read-only query that shouldn't disturb the cron schedule or update `lastPollTime`. |
| 3 | The `deduplicateEvents` logic is duplicated between `main.ts` and `channels/telegram.ts`. Should it be extracted to a shared utility now or deferred? | Open | Defer to Phase 6 or a cleanup pass. The duplication is minimal (10 lines) and extracting it now would change `main.ts`'s module structure unnecessarily. |
