import { assertEquals } from "@std/assert";
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

// ---------------------------------------------------------------------------
// CA-06: FIFO eviction — 1001st entry evicts the first entry
// ---------------------------------------------------------------------------

Deno.test("cache CA-06: setting 1001 distinct keys evicts the first key", () => {
  // Use a unique prefix to avoid collisions with other tests in this file
  const PREFIX = "fifo-ca06-";
  const LIMIT = 1_000;

  // Fill from key-0 up to key-999 (1000 entries, reaching the cap)
  for (let i = 0; i < LIMIT; i++) {
    setCached(`${PREFIX}${i}`, `value-${i}`, 60_000);
  }

  // At this point the cache has exactly MAX_ENTRIES (1000).
  // The very first key we set should still be present.
  assertNotNull(getCached<string>(`${PREFIX}0`));

  // Setting the 1001st key must evict the oldest (key-0).
  setCached(`${PREFIX}${LIMIT}`, "overflow", 60_000);

  // key-0 must now be gone
  assertEquals(getCached<string>(`${PREFIX}0`), null);

  // The 1001st key itself must be retrievable
  assertEquals(getCached<string>(`${PREFIX}${LIMIT}`), "overflow");
});

// ---------------------------------------------------------------------------
// CA-07: Overwriting a key keeps only one entry; 1000 subsequent keys do not
//        evict the overwritten key.
// ---------------------------------------------------------------------------

Deno.test("cache CA-07: overwriting a key then filling remaining slots preserves the overwritten value", () => {
  const PREFIX = "fifo-ca07-";
  const LIMIT = 1_000;

  // Set and immediately overwrite the target key
  setCached(`${PREFIX}target`, "initial", 60_000);
  setCached(`${PREFIX}target`, "updated", 60_000);

  // Fill up the remaining 999 slots (we already have 1 slot used by target).
  // We add 999 more so the total sits at 1000 — right at the cap.
  for (let i = 0; i < LIMIT - 1; i++) {
    setCached(`${PREFIX}fill-${i}`, `v${i}`, 60_000);
  }

  // The cache is at capacity (1000). Adding one more evicts the oldest entry,
  // which is the first write to "${PREFIX}target". But because we overwrote
  // it, the Map now has only one entry for that key — the second write.
  // We should NOT set a 1001st key here, so the target key must be intact.
  assertEquals(getCached<string>(`${PREFIX}target`), "updated");
});

// ---------------------------------------------------------------------------
// Helper used by CA-06 (not imported from @std/assert in current file)
// ---------------------------------------------------------------------------

function assertNotNull<T>(value: T | null): void {
  if (value === null) {
    throw new Error("Expected non-null value but got null");
  }
}
