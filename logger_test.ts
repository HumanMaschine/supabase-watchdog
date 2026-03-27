import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { log } from "./logger.ts";

Deno.test("log.info outputs valid JSON with correct fields", () => {
  const original = console.log;
  let captured = "";
  console.log = (msg: string) => { captured = msg; };

  log.info("test_message", { key: "value" });

  console.log = original;

  const parsed = JSON.parse(captured);
  assertEquals(parsed.level, "info");
  assertEquals(parsed.msg, "test_message");
  assertEquals(parsed.key, "value");
  assertEquals(typeof parsed.ts, "string");
});

Deno.test("log.error outputs to stderr", () => {
  const original = console.error;
  let captured = "";
  console.error = (msg: string) => { captured = msg; };

  log.error("error_msg", { code: 500 });

  console.error = original;

  const parsed = JSON.parse(captured);
  assertEquals(parsed.level, "error");
  assertEquals(parsed.msg, "error_msg");
  assertEquals(parsed.code, 500);
});

Deno.test("log.warn outputs to stderr", () => {
  const original = console.error;
  let captured = "";
  console.error = (msg: string) => { captured = msg; };

  log.warn("warn_msg");

  console.error = original;

  const parsed = JSON.parse(captured);
  assertEquals(parsed.level, "warn");
  assertEquals(parsed.msg, "warn_msg");
});

Deno.test("log entries include ISO timestamp", () => {
  const original = console.log;
  let captured = "";
  console.log = (msg: string) => { captured = msg; };

  log.info("ts_test");

  console.log = original;

  const parsed = JSON.parse(captured);
  // ISO 8601 format check
  assertStringIncludes(parsed.ts, "T");
  assertStringIncludes(parsed.ts, "Z");
});
