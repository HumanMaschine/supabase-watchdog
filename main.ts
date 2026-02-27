import { loadConfig, parseDuration } from "./config.ts";
import { SupabaseSource } from "./sources/mod.ts";
import { PassthroughProcessor } from "./processors/mod.ts";
import { TelegramChannel } from "./channels/mod.ts";
import type { ErrorEvent } from "./types.ts";

// --- Config & plugin init ---

const config = await loadConfig();

const source = new SupabaseSource(config);
const processor = new PassthroughProcessor();
const channel = new TelegramChannel(config);

let lastPollTime = new Date();

// --- Deduplication ---

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

// --- Core pipeline ---

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

// --- Cron scheduling ---

function intervalToCron(interval: string): string {
  const ms = parseDuration(interval);
  const minutes = Math.round(ms / 60_000);

  if (minutes < 1) {
    throw new Error("Polling interval must be at least 1 minute");
  }

  if (minutes < 60) {
    return `*/${minutes} * * * *`;
  }

  if (minutes % 60 !== 0) {
    throw new Error(
      `Polling interval "${interval}" (${minutes}m) does not map cleanly to a cron expression. Use 1–59 minutes or multiples of 60 minutes.`,
    );
  }

  const hours = minutes / 60;
  return `0 */${hours} * * *`;
}

const cronExpression = intervalToCron(config.polling.interval);

Deno.cron("watchdog-poll", cronExpression, async () => {
  await runPollCycle();
});

console.log(
  `[watchdog] Started — monitoring ${config.projects.length} project(s), polling every ${config.polling.interval}`,
);
console.log(`[watchdog] Cron scheduled: ${cronExpression}`);

// --- Initial poll ---

await runPollCycle();

// --- Bot polling ---

channel.startPolling({
  source,
  processor,
  getLastPollTime: () => lastPollTime,
  config,
});
