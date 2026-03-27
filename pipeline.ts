import type { ErrorEvent, PollCycleRecord, Source, Processor, Channel, WatchdogConfig } from "./types.ts";
import type { WatchdogState } from "./state.ts";
import { parseDuration } from "./config.ts";
import { log } from "./logger.ts";

// ── Deduplication ────────────────────────────────────────────────────

/**
 * Deduplicate events within a single cycle AND across cycles (KV-backed).
 * Fingerprint: projectRef:source:message (lowercased).
 */
export async function deduplicateEvents(
  events: ErrorEvent[],
  state: WatchdogState,
): Promise<ErrorEvent[]> {
  const seenThisCycle = new Set<string>();
  const unique: ErrorEvent[] = [];

  for (const event of events) {
    const fingerprint = `${event.projectRef}:${event.source}:${event.message}`.toLowerCase();

    // Within-cycle dedup
    if (seenThisCycle.has(fingerprint)) continue;
    seenThisCycle.add(fingerprint);

    // Cross-cycle dedup via KV
    const alreadySeen = await state.checkDedupSeen(fingerprint);
    if (alreadySeen) continue;

    await state.setDedupSeen(fingerprint);
    unique.push(event);
  }

  return unique;
}

// ── Core pipeline ────────────────────────────────────────────────────

export async function runPollCycle(
  source: Source,
  processor: Processor,
  channel: Channel,
  state: WatchdogState,
  lastPollTime: Date,
  config?: WatchdogConfig,
): Promise<{ newLastPollTime: Date; errorsFound: number; alertsSent: number }> {
  const cycleStart = new Date();
  log.info("poll_cycle_started", { time: cycleStart.toISOString() });

  let errorsFound = 0;
  let alertsSent = 0;
  let ok = true;
  const failures: PollCycleRecord["failures"] = [];
  // Track which project:source pairs had errors (for per-source health matrix)
  const errorSources = new Set<string>();

  try {
    // 1. Poll
    const events = await source.poll(lastPollTime);
    log.info("poll_complete", { events: events.length });

    // 2. Deduplicate (KV-backed)
    const unique = await deduplicateEvents(events, state);
    if (unique.length < events.length) {
      log.info("dedup_filtered", {
        before: events.length,
        after: unique.length,
      });
    }

    errorsFound = unique.length;

    // Track which sources had errors (for health matrix)
    for (const event of unique) {
      errorSources.add(`${event.projectRef}:${event.source}`);
    }

    // 3. Process
    const processed = await processor.process(unique);

    // 4. Send
    if (processed.length > 0) {
      await channel.send(processed);
      alertsSent = processed.length;
      log.info("alerts_sent", { count: alertsSent });
    } else {
      log.info("no_errors_found");
    }
  } catch (error) {
    ok = false;
    log.error("poll_cycle_failed", { error: String(error) });
    failures.push({
      project: "all",
      source: "pipeline",
      error: String(error),
    });
  }

  const cycleEnd = new Date();
  const durationMs = cycleEnd.getTime() - cycleStart.getTime();

  // Update per-source health in KV
  if (config) {
    for (const project of config.projects) {
      for (const src of config.polling.sources) {
        const key = `${project.ref}:${src}`;
        const sourceOk = !errorSources.has(key);
        await state.updateHealth(project.ref, src, sourceOk);
      }
    }
  }

  // Log to KV
  const record: PollCycleRecord = {
    started_at: cycleStart.toISOString(),
    finished_at: cycleEnd.toISOString(),
    duration_ms: durationMs,
    ok,
    errors_found: errorsFound,
    alerts_sent: alertsSent,
    failures,
  };

  await state.logPollCycle(record);
  await state.persistLastPollTime(cycleStart, ok);
  await state.updateDailyStats(errorsFound, alertsSent);

  log.info("poll_cycle_complete", {
    duration_ms: durationMs,
    errors_found: errorsFound,
    alerts_sent: alertsSent,
    ok,
  });

  return { newLastPollTime: cycleStart, errorsFound, alertsSent };
}

// ── Cron helpers ─────────────────────────────────────────────────────

export function intervalToCron(interval: string): string {
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
