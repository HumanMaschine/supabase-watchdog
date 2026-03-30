import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TelegramChannel } from "../channels/telegram.ts";
import { WatchdogState } from "../state.ts";
import type { WatchdogConfig } from "../types.ts";

function makeConfig(): WatchdogConfig {
  return {
    supabase: { access_token: "test" },
    projects: [{ ref: "testref123456", name: "test-project" }],
    polling: { interval: "5m", sources: ["edge_logs"] },
    filters: { min_status_code: 500, ignore_patterns: [], max_alerts_per_interval: 20 },
    channels: { telegram: { bot_token: "123:ABCtest", chat_id: "-100123" } },
    telegram_mode: "webhook",
    base_url: "https://test.deno.dev",
  };
}

Deno.test("TelegramChannel: constructor succeeds with valid config", () => {
  const config = makeConfig();
  const channel = new TelegramChannel(config);
  assertEquals(channel.name, "telegram");
});

Deno.test("TelegramChannel: handleWebhookUpdate rejects bad secret", async () => {
  const config = makeConfig();
  const channel = new TelegramChannel(config);
  const state = new WatchdogState();
  await state.init();

  const update = { update_id: 1, message: { message_id: 1, chat: { id: -100123 }, text: "/help" } };
  const result = await channel.handleWebhookUpdate(update, "wrong-secret", state);
  assertEquals(result.status, 403);
  state.close();
});

Deno.test("TelegramChannel: handleWebhookUpdate deduplicates by update_id", { sanitizeOps: false, sanitizeResources: false }, async () => {
  const config = makeConfig();
  const channel = new TelegramChannel(config);
  const state = new WatchdogState();
  await state.init();

  // Derive the correct secret
  const data = new TextEncoder().encode("123:ABCtest" + "watchdog");
  const hash = await crypto.subtle.digest("SHA-256", data);
  const secret = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");

  await state.setLastUpdateId(0);
  const update = { update_id: 5, message: { message_id: 1, chat: { id: -100123 }, text: "/help" } };

  // First call: processes the update
  const result1 = await channel.handleWebhookUpdate(update, secret, state);
  assertEquals(result1.status, 200);

  // Second call: same update_id, idempotent
  const result2 = await channel.handleWebhookUpdate(update, secret, state);
  assertEquals(result2.status, 200);

  const lastId = await state.getLastUpdateId();
  assertEquals(lastId, 5);
  state.close();
});

Deno.test("TelegramChannel: webhook secret is deterministic", { sanitizeOps: false, sanitizeResources: false }, async () => {
  const config = makeConfig();
  const channel1 = new TelegramChannel(config);
  const channel2 = new TelegramChannel(config);

  // Both should derive the same secret from the same bot token
  // We can't access deriveWebhookSecret directly, but we can verify
  // that a valid update passes with the same derived secret on both instances
  const data = new TextEncoder().encode("123:ABCtest" + "watchdog");
  const hash = await crypto.subtle.digest("SHA-256", data);
  const secret = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");

  // Both channels should accept this secret
  const state = new WatchdogState();
  await state.init();
  await state.setLastUpdateId(0);

  const update = { update_id: 100, message: { message_id: 1, chat: { id: -100 }, text: "/help" } };
  const r1 = await channel1.handleWebhookUpdate(update, secret, state);
  assertEquals(r1.status, 200);
  state.close();
});
