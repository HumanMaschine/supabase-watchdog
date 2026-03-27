import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseDuration, loadConfig, checkRequiredEnvVars } from "./config.ts";

// ── parseDuration ────────────────────────────────────────────────────

Deno.test("parseDuration: 5m → 300000ms", () => {
  assertEquals(parseDuration("5m"), 300_000);
});

Deno.test("parseDuration: 2h30m → 9000000ms", () => {
  assertEquals(parseDuration("2h30m"), 9_000_000);
});

Deno.test("parseDuration: 1h → 3600000ms", () => {
  assertEquals(parseDuration("1h"), 3_600_000);
});

Deno.test("parseDuration: 30s with noMinimum → 30000ms", () => {
  assertEquals(parseDuration("30s", { noMinimum: true }), 30_000);
});

Deno.test("parseDuration: 30s without noMinimum throws (below 1min)", () => {
  assertThrows(() => parseDuration("30s"), Error, "below minimum");
});

Deno.test("parseDuration: invalid string throws", () => {
  assertThrows(() => parseDuration("abc"), Error, "not a valid duration");
});

// ── checkRequiredEnvVars ─────────────────────────────────────────────

Deno.test("checkRequiredEnvVars: returns missing vars", () => {
  // Clear all relevant env vars
  const vars = ["SUPABASE_ACCESS_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "WATCHDOG_PROJECTS"];
  const saved = vars.map(v => [v, Deno.env.get(v)] as const);
  vars.forEach(v => { try { Deno.env.delete(v); } catch { /* */ } });

  const missing = checkRequiredEnvVars();
  assertEquals(missing.length, 4);
  assertEquals(missing.includes("SUPABASE_ACCESS_TOKEN"), true);
  assertEquals(missing.includes("WATCHDOG_PROJECTS"), true);

  // Restore
  saved.forEach(([k, v]) => { if (v) Deno.env.set(k, v); });
});

// ── loadConfig ───────────────────────────────────────────────────────

Deno.test("loadConfig: missing YAML + no env vars → configured: false", async () => {
  // Clear env vars
  const vars = ["SUPABASE_ACCESS_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "WATCHDOG_PROJECTS"];
  const saved = vars.map(v => [v, Deno.env.get(v)] as const);
  vars.forEach(v => { try { Deno.env.delete(v); } catch { /* */ } });

  const result = await loadConfig("/nonexistent/path.yaml");
  assertEquals(result.configured, false);
  if (!result.configured) {
    assertEquals(result.missing.length > 0, true);
  }

  // Restore
  saved.forEach(([k, v]) => { if (v) Deno.env.set(k, v); });
});

Deno.test("loadConfig: env vars set → configured: true", async () => {
  const saved = new Map<string, string | undefined>();
  const testVars: Record<string, string> = {
    SUPABASE_ACCESS_TOKEN: "sbp_test_token_123",
    TELEGRAM_BOT_TOKEN: "123456:ABCtest",
    TELEGRAM_CHAT_ID: "-1001234567890",
    WATCHDOG_PROJECTS: "abcdefghijklmn:test-project",
  };

  // Save and set
  for (const [k, v] of Object.entries(testVars)) {
    saved.set(k, Deno.env.get(k));
    Deno.env.set(k, v);
  }

  const result = await loadConfig("/nonexistent/path.yaml");
  assertEquals(result.configured, true);
  if (result.configured) {
    assertEquals(result.config.projects.length, 1);
    assertEquals(result.config.projects[0]!.ref, "abcdefghijklmn");
    assertEquals(result.config.projects[0]!.name, "test-project");
    assertEquals(result.config.polling.interval, "5m");
    assertEquals(result.config.polling.sources.length, 7);
  }

  // Restore
  for (const [k, v] of saved) {
    if (v) Deno.env.set(k, v);
    else { try { Deno.env.delete(k); } catch { /* */ } }
  }
});

Deno.test("loadConfig: malformed WATCHDOG_PROJECTS throws", async () => {
  const saved = new Map<string, string | undefined>();
  const testVars: Record<string, string> = {
    SUPABASE_ACCESS_TOKEN: "sbp_test_token_123",
    TELEGRAM_BOT_TOKEN: "123456:ABCtest",
    TELEGRAM_CHAT_ID: "-1001234567890",
    WATCHDOG_PROJECTS: "no_colon_here",
  };

  for (const [k, v] of Object.entries(testVars)) {
    saved.set(k, Deno.env.get(k));
    Deno.env.set(k, v);
  }

  await assertRejects(
    () => loadConfig("/nonexistent/path.yaml"),
    Error,
    "ref:name",
  );

  for (const [k, v] of saved) {
    if (v) Deno.env.set(k, v);
    else { try { Deno.env.delete(k); } catch { /* */ } }
  }
});

Deno.test("loadConfig: multiple projects parsed correctly", async () => {
  const saved = new Map<string, string | undefined>();
  const testVars: Record<string, string> = {
    SUPABASE_ACCESS_TOKEN: "sbp_test_token_123",
    TELEGRAM_BOT_TOKEN: "123456:ABCtest",
    TELEGRAM_CHAT_ID: "-1001234567890",
    WATCHDOG_PROJECTS: "abcdefghijklmn:app-one,zyxwvutsrqpon:app-two",
  };

  for (const [k, v] of Object.entries(testVars)) {
    saved.set(k, Deno.env.get(k));
    Deno.env.set(k, v);
  }

  const result = await loadConfig("/nonexistent/path.yaml");
  assertEquals(result.configured, true);
  if (result.configured) {
    assertEquals(result.config.projects.length, 2);
    assertEquals(result.config.projects[1]!.name, "app-two");
  }

  for (const [k, v] of saved) {
    if (v) Deno.env.set(k, v);
    else { try { Deno.env.delete(k); } catch { /* */ } }
  }
});
