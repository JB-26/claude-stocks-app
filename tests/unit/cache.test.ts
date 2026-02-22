import { assertEquals } from "jsr:@std/assert";
import { getCached, setCached } from "../../lib/cache.ts";

Deno.test("cache: returns null on miss", () => {
  const result = getCached<string>("unit-miss");
  assertEquals(result, null);
});

Deno.test("cache: returns stored value before TTL expires", () => {
  setCached("unit-hit", "hello", 5_000);
  assertEquals(getCached<string>("unit-hit"), "hello");
});

Deno.test("cache: returns null after TTL expires", async () => {
  setCached("unit-ttl", "bye", 1);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(getCached<string>("unit-ttl"), null);
});

Deno.test("cache: overwrites an existing entry", () => {
  setCached("unit-overwrite", "first", 5_000);
  setCached("unit-overwrite", "second", 5_000);
  assertEquals(getCached<string>("unit-overwrite"), "second");
});

Deno.test("cache: stores and retrieves complex objects", () => {
  const obj = { a: 1, b: [2, 3], c: { d: "hello" } };
  setCached("unit-object", obj, 5_000);
  assertEquals(getCached<typeof obj>("unit-object"), obj);
});
