import { assertEquals, assertGreater } from "@std/assert";
import { checkRateLimit } from "../../lib/ratelimit.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a Request with a given IP (via x-forwarded-for) against a given path.
 * Each test uses a unique IP+path pair to avoid sharing module-level Map state
 * with other tests (the ipWindows Map is never reset between tests).
 */
function makeRequest(ip: string | null, path: string): Request {
  const headers: Record<string, string> = {};
  if (ip !== null) {
    headers["x-forwarded-for"] = ip;
  }
  return new Request(`http://localhost${path}`, { headers });
}

// ---------------------------------------------------------------------------
// RL-01: 30 requests from same IP+route within window — all allowed
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-01: first 30 requests from same IP+route all return allowed", () => {
  const ip = "10.0.1.1";
  const path = "/api/stock/rl01";

  for (let i = 0; i < 30; i++) {
    const result = checkRateLimit(makeRequest(ip, path));
    assertEquals(result.allowed, true, `Request ${i + 1} should be allowed`);
  }
});

// ---------------------------------------------------------------------------
// RL-02: 31st request from same IP+route within window — rejected with retryAfterMs
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-02: 31st request from same IP+route within window returns not allowed with retryAfterMs", () => {
  const ip = "10.0.2.1";
  const path = "/api/stock/rl02";

  // Exhaust the 30-request allowance
  for (let i = 0; i < 30; i++) {
    checkRateLimit(makeRequest(ip, path));
  }

  // The 31st request must be rejected with a positive retryAfterMs
  const result = checkRateLimit(makeRequest(ip, path));
  assertEquals(result.allowed, false);
  assertGreater(result.retryAfterMs, 0);
});

// ---------------------------------------------------------------------------
// RL-03: No x-forwarded-for header — does not throw, returns allowed
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-03: request with no x-forwarded-for header does not throw and returns allowed", () => {
  // No IP header — function should fall back to "unknown" key
  // Use a unique path so we don't collide with other no-header tests
  const req = new Request("http://localhost/api/stock/rl03");
  const result = checkRateLimit(req);
  assertEquals(result.allowed, true);
});

// ---------------------------------------------------------------------------
// RL-04: Rate limit is keyed per-route — different routes are independent
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-04: exhausting limit on one route does not affect a different route from same IP", () => {
  const ip = "10.0.4.1";
  const quotePath = "/api/stock/quote";
  const searchPath = "/api/stock/search";

  // Exhaust the quote route
  for (let i = 0; i < 30; i++) {
    checkRateLimit(makeRequest(ip, quotePath));
  }
  // 31st request on quote should be rejected
  assertEquals(checkRateLimit(makeRequest(ip, quotePath)).allowed, false);

  // But the first request on the search route from same IP should still pass
  assertEquals(checkRateLimit(makeRequest(ip, searchPath)).allowed, true);
});

// ---------------------------------------------------------------------------
// RL-05: x-forwarded-for with multiple IPs — only first value used as key
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-05: x-forwarded-for with proxy chain uses only the first IP as the key", () => {
  // Exhaust the limit for 1.2.3.4 on this path
  const path = "/api/stock/rl05";
  for (let i = 0; i < 30; i++) {
    checkRateLimit(makeRequest("1.2.3.4", path));
  }
  // 31st request for 1.2.3.4 should be rejected
  const rejectedReq = new Request(`http://localhost${path}`, {
    headers: { "x-forwarded-for": "1.2.3.4" },
  });
  assertEquals(checkRateLimit(rejectedReq).allowed, false);

  // A request with "1.2.3.4, 5.6.7.8" should also be rejected because
  // the extracted IP is "1.2.3.4" (same exhausted key)
  const chainedReq = new Request(`http://localhost${path}`, {
    headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
  });
  assertEquals(checkRateLimit(chainedReq).allowed, false);

  // A fresh request for "5.6.7.8" alone on the same path is still allowed,
  // confirming that 5.6.7.8 is a separate key
  const freshReq = new Request(`http://localhost${path}`, {
    headers: { "x-forwarded-for": "5.6.7.8" },
  });
  assertEquals(checkRateLimit(freshReq).allowed, true);
});
