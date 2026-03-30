import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertThrows } from "https://deno.land/std@0.224.0/assert/assert_throws.ts";
import { intervalToCron, deduplicateEvents } from "../pipeline.ts";
import { WatchdogState } from "../state.ts";
import type { ErrorEvent } from "../types.ts";

// ── intervalToCron ───────────────────────────────────────────────────

Deno.test("intervalToCron: 5m → */5 * * * *", () => {
  assertEquals(intervalToCron("5m"), "*/5 * * * *");
});

Deno.test("intervalToCron: 1m → */1 * * * *", () => {
  assertEquals(intervalToCron("1m"), "*/1 * * * *");
});

Deno.test("intervalToCron: 2h → 0 */2 * * *", () => {
  assertEquals(intervalToCron("2h"), "0 */2 * * *");
});

Deno.test("intervalToCron: 90m throws", () => {
  assertThrows(() => intervalToCron("90m"), Error, "does not map cleanly");
});

// ── deduplicateEvents ────────────────────────────────────────────────

function makeEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    project: "test",
    projectRef: "testref12345",
    source: "edge_logs",
    timestamp: new Date().toISOString(),
    message: "test error",
    ...overrides,
  };
}

Deno.test("deduplicateEvents: removes within-cycle duplicates", async () => {
  const state = new WatchdogState();
  await state.init();
  const events = [
    makeEvent({ message: "dedup-a-" + Date.now() }),
    makeEvent({ message: "dedup-a-" + Date.now() }),
    makeEvent({ message: "dedup-b-" + Date.now() }),
  ];
  // First two have same message prefix but different timestamps in the message
  // Let's use exact same message
  const ts = Date.now();
  const eventsExact = [
    makeEvent({ message: "same-msg-" + ts }),
    makeEvent({ message: "same-msg-" + ts }),
    makeEvent({ message: "diff-msg-" + ts }),
  ];
  const unique = await deduplicateEvents(eventsExact, state);
  assertEquals(unique.length, 2);
  state.close();
});

Deno.test("deduplicateEvents: cross-cycle dedup via KV", async () => {
  const state = new WatchdogState();
  await state.init();
  const msg = "recurring-" + Date.now();
  const event = makeEvent({ message: msg });
  const first = await deduplicateEvents([event], state);
  assertEquals(first.length, 1);
  const second = await deduplicateEvents([makeEvent({ message: msg })], state);
  assertEquals(second.length, 0);
  state.close();
});

Deno.test("deduplicateEvents: different messages pass through", async () => {
  const state = new WatchdogState();
  await state.init();
  const ts = Date.now();
  const events = [
    makeEvent({ message: "unique-a-" + ts }),
    makeEvent({ message: "unique-b-" + ts }),
  ];
  const unique = await deduplicateEvents(events, state);
  assertEquals(unique.length, 2);
  state.close();
});
