import { loadConfig } from "./config.ts";
import { log } from "./logger.ts";
import { WatchdogState } from "./state.ts";
import { startServer } from "./server.ts";
import { runPollCycle, intervalToCron } from "./pipeline.ts";
import { SupabaseSource } from "./sources/mod.ts";
import { PassthroughProcessor } from "./processors/mod.ts";
import { TelegramChannel } from "./channels/mod.ts";
import { parseDuration } from "./config.ts";

// ── Config ───────────────────────────────────────────────────────────

const result = await loadConfig();

if (!result.configured) {
  // SETUP MODE: serve setup page, wait for env vars
  log.info("setup_mode", { missing: result.missing });

  startServer({
    mode: "setup",
    missing: result.missing,
  });

  // Nothing else to start — user needs to add env vars
} else {
  // MONITORING MODE: full pipeline + dashboard
  const config = result.config;

  log.info("monitoring_mode", {
    projects: config.projects.length,
    interval: config.polling.interval,
    telegram_mode: config.telegram_mode,
  });

  // Token validation
  try {
    const resp = await fetch("https://api.supabase.com/v1/projects", {
      headers: { Authorization: `Bearer ${config.supabase.access_token}` },
    });
    if (!resp.ok) {
      log.warn("token_validation_failed", { status: resp.status });
    } else {
      log.info("token_validated");
    }
    // Consume body to prevent leak
    await resp.text();
  } catch (err) {
    log.warn("token_validation_error", { error: String(err) });
  }

  // Initialize state (KV)
  const state = new WatchdogState();
  await state.init();

  // Initialize plugins
  const source = new SupabaseSource(config);
  const processor = new PassthroughProcessor();
  const channel = new TelegramChannel(config);

  // Restore lastPollTime from KV (survives restarts)
  let lastPollTime = new Date();
  const storedPoll = await state.getLastPollTime();
  if (storedPoll) {
    lastPollTime = new Date(storedPoll.timestamp);
    log.info("restored_last_poll_time", { timestamp: storedPoll.timestamp });
  }

  // Set up Telegram (webhook or polling)
  const botDeps = {
    source,
    processor,
    getLastPollTime: () => lastPollTime,
    config,
  };

  if (config.telegram_mode === "webhook" && config.base_url) {
    await channel.setupWebhook(botDeps, config.base_url);
  } else {
    channel.startPolling(botDeps);
  }

  // Start HTTP server
  startServer({
    mode: "monitoring",
    state,
    config,
    onTelegramWebhook: config.telegram_mode === "webhook"
      ? async (update, secretHeader) => {
          const telegramUpdate = update as { update_id: number; message?: { message_id: number; chat: { id: number }; text?: string } };
          return await channel.handleWebhookUpdate(telegramUpdate, secretHeader, state);
        }
      : undefined,
  });

  // Schedule cron
  const cronExpression = intervalToCron(config.polling.interval);
  Deno.cron("watchdog-poll", cronExpression, async () => {
    const result = await runPollCycle(source, processor, channel, state, lastPollTime);
    lastPollTime = result.newLastPollTime;

    // Update health for each configured project/source
    for (const project of config.projects) {
      for (const src of config.polling.sources) {
        const hasFailure = result.errorsFound > 0; // Simplified — per-source health would need source-level tracking
        await state.updateHealth(project.ref, src, !hasFailure);
      }
    }
  });

  log.info("cron_scheduled", { expression: cronExpression });

  // Initial poll
  const initial = await runPollCycle(source, processor, channel, state, lastPollTime);
  lastPollTime = initial.newLastPollTime;
}
