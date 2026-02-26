import { assertEquals } from "@std/assert";
import { checkRateLimit } from "../../lib/ratelimit.ts";

// ---------------------------------------------------------------------------
// 429 path in GET /api/stock/search
//
// The route handler's first line is:
//   if (!checkRateLimit(request)) {
//     return NextResponse.json({ error: "Too many requests" }, { status: 429 });
//   }
//
// The route file imports from "@/lib/ratelimit" (Next.js path alias), which
// Deno cannot resolve in a plain `deno test` context. Therefore we test the
// 429 gate by verifying `checkRateLimit` itself returns false after the window
// is exhausted — which is the only condition that causes the handler to 429.
//
// This approach tests the same logic boundary without requiring the Next.js
// bundler environment. An integration test over HTTP (deno task test:e2e) is
// the appropriate layer for full handler invocation.
// ---------------------------------------------------------------------------

Deno.test("search route 429 gate: checkRateLimit returns false after 30 requests, which triggers the 429 branch", () => {
  const ip = "192.168.99.1";
  const path = "/api/stock/search";

  function makeReq(): Request {
    return new Request(`http://localhost${path}?q=Apple`, {
      headers: { "x-forwarded-for": ip },
    });
  }

  // Exhaust the 30-request allowance — all should be allowed
  for (let i = 0; i < 30; i++) {
    const allowed = checkRateLimit(makeReq());
    assertEquals(allowed, true, `Request ${i + 1} should be allowed`);
  }

  // The 31st call returns false — the condition that causes the handler to
  // short-circuit and return { status: 429 }
  const shouldReject = checkRateLimit(makeReq());
  assertEquals(shouldReject, false, "31st request should be rejected (would produce HTTP 429)");
});
