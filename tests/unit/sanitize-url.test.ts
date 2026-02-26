import { assertEquals, assertNotEquals } from "@std/assert";
import { sanitizeUrl } from "../../lib/sanitize-url.ts";

// ---------------------------------------------------------------------------
// SU-01: https URL — allowed
// ---------------------------------------------------------------------------

Deno.test("sanitizeUrl SU-01: https URL returns non-null", () => {
  const result = sanitizeUrl("https://example.com/article");
  assertNotEquals(result, null);
});

// ---------------------------------------------------------------------------
// SU-02: http URL — allowed
// ---------------------------------------------------------------------------

Deno.test("sanitizeUrl SU-02: http URL returns non-null", () => {
  const result = sanitizeUrl("http://example.com/article");
  assertNotEquals(result, null);
});

// ---------------------------------------------------------------------------
// SU-03: javascript: protocol — rejected
// ---------------------------------------------------------------------------

Deno.test("sanitizeUrl SU-03: javascript: protocol returns null", () => {
  assertEquals(sanitizeUrl("javascript:alert(1)"), null);
});

// ---------------------------------------------------------------------------
// SU-04: data: URI — rejected
// ---------------------------------------------------------------------------

Deno.test("sanitizeUrl SU-04: data: URI returns null", () => {
  assertEquals(sanitizeUrl("data:text/html,<h1>x</h1>"), null);
});

// ---------------------------------------------------------------------------
// SU-05: mailto: protocol — rejected
// ---------------------------------------------------------------------------

Deno.test("sanitizeUrl SU-05: mailto: protocol returns null", () => {
  assertEquals(sanitizeUrl("mailto:user@example.com"), null);
});

// ---------------------------------------------------------------------------
// SU-06: relative path — rejected (URL constructor throws without a base)
// ---------------------------------------------------------------------------

Deno.test("sanitizeUrl SU-06: relative path returns null", () => {
  assertEquals(sanitizeUrl("/relative/path"), null);
});

// ---------------------------------------------------------------------------
// SU-07: empty string — rejected
// ---------------------------------------------------------------------------

Deno.test("sanitizeUrl SU-07: empty string returns null", () => {
  assertEquals(sanitizeUrl(""), null);
});

// ---------------------------------------------------------------------------
// SU-08: arbitrary non-URL text — rejected
// ---------------------------------------------------------------------------

Deno.test("sanitizeUrl SU-08: non-URL text returns null", () => {
  assertEquals(sanitizeUrl("not a url at all"), null);
});
