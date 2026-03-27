import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { WatchdogState } from "./state.ts";

Deno.test("state: persistLastPollTime + getLastPollTime round-trip", async () => {
  const state = new WatchdogState();
  await state.init();
  const now = new Date();
  await state.persistLastPollTime(now, true);
  const result = await state.getLastPollTime();
  assertEquals(result?.ok, true);
  assertEquals(result?.timestamp, now.toISOString());
  state.close();
});

Deno.test("state: logPollCycle + getRecentPolls", async () => {
  const state = new WatchdogState();
  await state.init();
  await state.logPollCycle({
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 1200,
    ok: true,
    errors_found: 3,
    alerts_sent: 2,
    failures: [],
  });
  const polls = await state.getRecentPolls(10);
  assertEquals(polls.length >= 1, true);
  state.close();
});

Deno.test("state: updateHealth + getHealthMatrix", async () => {
  const state = new WatchdogState();
  await state.init();
  await state.updateHealth("proj123abc", "edge_logs", true);
  await state.updateHealth("proj123abc", "auth_logs", false, "auth error");
  const matrix = await state.getHealthMatrix();
  assertEquals(matrix.has("proj123abc"), true);
  const proj = matrix.get("proj123abc")!;
  assertEquals(proj.get("edge_logs")?.ok, true);
  assertEquals(proj.get("auth_logs")?.ok, false);
  state.close();
});

Deno.test("state: updateDailyStats + getDailyStats", async () => {
  const state = new WatchdogState();
  await state.init();
  await state.updateDailyStats(5, 3);
  const stats = await state.getDailyStats();
  assertEquals(stats.polls >= 1, true);
  assertEquals(stats.errors_found >= 5, true);
  state.close();
});

Deno.test("state: checkDedupSeen + setDedupSeen", async () => {
  const state = new WatchdogState();
  await state.init();
  const fp = "test-fingerprint-" + Date.now();
  assertEquals(await state.checkDedupSeen(fp), false);
  await state.setDedupSeen(fp);
  assertEquals(await state.checkDedupSeen(fp), true);
  state.close();
});

Deno.test("state: getLastUpdateId + setLastUpdateId", async () => {
  const state = new WatchdogState();
  await state.init();
  await state.setLastUpdateId(42);
  const id = await state.getLastUpdateId();
  assertEquals(id, 42);
  state.close();
});

Deno.test("state: getStartedAt returns a timestamp after init", async () => {
  const state = new WatchdogState();
  await state.init();
  const started = await state.getStartedAt();
  assertEquals(typeof started, "string");
  state.close();
});
