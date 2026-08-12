import { assert, assertEquals } from "@std/assert";

// ---------------------------------------------------------------------------
// upstream-budget.test.ts
//
// Unit tests for the outbound-call budgets in lib/ratelimit.ts —
// `reserveUpstreamCalls` / `releaseUpstreamCalls` — plus client identity and
// the `maxRequests` override on `checkRateLimit`.
//
// These exist because `checkRateLimit` alone cannot protect the single shared
// Finnhub API key on a fan-out route: it bounds inbound REQUESTS, and
// GET /api/stock/watchlist-quotes turns one request into up to 20 upstream
// calls. The budget meters the outbound side directly, so the ceiling is a
// fixed number of Finnhub calls per minute rather than (requests x fan-out).
//
// The budget windows are module-scoped and never reset between tests, so every
// test below uses its own unique key.
// ---------------------------------------------------------------------------

import {
  checkRateLimit,
  getClientIdentity,
  getClientIp,
  releaseUpstreamCalls,
  reserveUpstreamCalls,
  UNIDENTIFIED_CLIENT,
  UNTRUSTED_CLIENT,
  type ClientIdentity,
} from "../../lib/ratelimit.ts";

function makeRequest(ip: string | null, path: string): Request {
  const headers: Record<string, string> = {};
  if (ip !== null) headers["x-forwarded-for"] = ip;
  return new Request(`http://localhost${path}`, { headers });
}

/**
 * Runs `fn` with `Date.now` frozen at `start`, plus an `advance` callback to
 * move it forward.
 *
 * The windows in lib/ratelimit.ts are fixed 60-second spans keyed off
 * `Date.now()`, so the reset path is unreachable in a test suite that runs in
 * about a second of real time. Stubbing the clock rather than pulling in
 * @std/testing's FakeTime keeps the suite dependency-free (deno.json's import
 * map only carries @std/assert) and avoids faking timers this module never
 * uses. Always restored, including on failure.
 */
function withFrozenClock<T>(
  start: number,
  fn: (advance: (ms: number) => void) => T
): T {
  const realNow = Date.now;
  let current = start;
  Date.now = () => current;
  try {
    return fn((ms) => {
      current += ms;
    });
  } finally {
    Date.now = realNow;
  }
}

/** One window's length in lib/ratelimit.ts. */
const WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// UB-01: a request inside the budget is granted in full
// ---------------------------------------------------------------------------

Deno.test("upstream-budget UB-01: a request within the limit is granted in full", () => {
  const bucket = { key: "ub01", limit: 25 };
  assertEquals(reserveUpstreamCalls([bucket], 20).granted, 20);
});

// ---------------------------------------------------------------------------
// UB-02: an over-budget request is partially granted, never rejected outright
// ---------------------------------------------------------------------------

Deno.test("upstream-budget UB-02: a request exceeding the remaining allowance is granted partially", () => {
  const bucket = { key: "ub02", limit: 25 };

  assertEquals(reserveUpstreamCalls([bucket], 20).granted, 20);
  // Only 5 left in the window — the caller fetches 5 and degrades the rest.
  assertEquals(reserveUpstreamCalls([bucket], 20).granted, 5);
});

// ---------------------------------------------------------------------------
// UB-03: an exhausted budget grants nothing, and stays that way
// ---------------------------------------------------------------------------

Deno.test("upstream-budget UB-03: once the window's budget is spent every further reservation is zero", () => {
  const bucket = { key: "ub03", limit: 30 };

  assertEquals(reserveUpstreamCalls([bucket], 30).granted, 30);
  assertEquals(reserveUpstreamCalls([bucket], 1).granted, 0);
  assertEquals(reserveUpstreamCalls([bucket], 20).granted, 0);
});

// ---------------------------------------------------------------------------
// UB-04: the tightest bucket binds, and the others are not over-charged
//
// This is why reservation is a single atomic call rather than peek-then-commit:
// a peek-then-commit API would have deducted the full request from the roomy
// bucket before discovering the tight one was the constraint.
// ---------------------------------------------------------------------------

Deno.test("upstream-budget UB-04: the grant is the minimum across all buckets", () => {
  const perIp = { key: "ub04-ip", limit: 2 };
  const global = { key: "ub04-global", limit: 100 };

  assertEquals(reserveUpstreamCalls([perIp, global], 20).granted, 2);
});

Deno.test("upstream-budget UB-04b: the non-binding bucket is charged only what was actually granted", () => {
  const perIp = { key: "ub04b-ip", limit: 2 };
  const global = { key: "ub04b-global", limit: 100 };

  assertEquals(reserveUpstreamCalls([perIp, global], 20).granted, 2);
  // 98 of the global budget must remain — not 80, and not 0.
  assertEquals(reserveUpstreamCalls([global], 100).granted, 98);
});

Deno.test("upstream-budget UB-04c: a global bucket caps the total regardless of how many distinct IPs are used", () => {
  const global = { key: "ub04c-global", limit: 30 };

  // Ten different IPs, each with plenty of its own per-IP allowance.
  let totalGranted = 0;
  for (let i = 0; i < 10; i++) {
    totalGranted += reserveUpstreamCalls(
      [{ key: `ub04c-ip-${i}`, limit: 25 }, global],
      20
    ).granted;
  }

  assertEquals(
    totalGranted,
    30,
    "spreading across IPs must not buy more upstream calls than the global cap"
  );
});

// ---------------------------------------------------------------------------
// UB-05: degenerate inputs fail closed and consume nothing
// ---------------------------------------------------------------------------

Deno.test("upstream-budget UB-05: a zero request grants zero and consumes no budget", () => {
  const bucket = { key: "ub05", limit: 10 };

  assertEquals(reserveUpstreamCalls([bucket], 0).granted, 0);
  assertEquals(reserveUpstreamCalls([bucket], 10).granted, 10);
});

Deno.test("upstream-budget UB-05b: NaN, Infinity and negative requests grant zero and consume no budget", () => {
  const bucket = { key: "ub05b", limit: 10 };

  assertEquals(reserveUpstreamCalls([bucket], NaN).granted, 0);
  assertEquals(reserveUpstreamCalls([bucket], Infinity).granted, 0);
  assertEquals(reserveUpstreamCalls([bucket], -5).granted, 0);
  assertEquals(reserveUpstreamCalls([bucket], 10).granted, 10);
});

Deno.test("upstream-budget UB-05c: a bucket with a zero or non-finite limit grants nothing", () => {
  assertEquals(reserveUpstreamCalls([{ key: "ub05c-a", limit: 0 }], 5).granted, 0);
  assertEquals(reserveUpstreamCalls([{ key: "ub05c-b", limit: NaN }], 5).granted, 0);
});

Deno.test("upstream-budget UB-05d: a fractional request is floored rather than rounded up", () => {
  assertEquals(reserveUpstreamCalls([{ key: "ub05d", limit: 10 }], 3.9).granted, 3);
});

// ---------------------------------------------------------------------------
// UB-06: buckets are isolated by key
// ---------------------------------------------------------------------------

Deno.test("upstream-budget UB-06: exhausting one key does not affect another", () => {
  assertEquals(reserveUpstreamCalls([{ key: "ub06-a", limit: 5 }], 5).granted, 5);
  assertEquals(reserveUpstreamCalls([{ key: "ub06-a", limit: 5 }], 5).granted, 0);
  assertEquals(reserveUpstreamCalls([{ key: "ub06-b", limit: 5 }], 5).granted, 5);
});

// ---------------------------------------------------------------------------
// UB-07: client identity
//
// The per-client budget must key off exactly the same identity the request
// limiter does, and an unattributable caller must be visibly unattributable
// rather than silently keyed to a placeholder that everyone shares.
// ---------------------------------------------------------------------------

Deno.test("upstream-budget UB-07: getClientIdentity takes the last X-Forwarded-For entry, not the spoofable first", () => {
  const identity = getClientIdentity(
    makeRequest("1.2.3.4, 5.6.7.8", "/api/stock/watchlist-quotes")
  );

  assertEquals(identity.identified, true);
  assertEquals(identity.key, "ip:5.6.7.8");
  assertEquals(
    getClientIp(makeRequest("1.2.3.4, 5.6.7.8", "/api/stock/watchlist-quotes")),
    identity.key,
    "getClientIp must agree with getClientIdentity, or the request limit and " +
      "the upstream budget would meter different clients"
  );
});

Deno.test("upstream-budget UB-07b: a request with no X-Forwarded-For is UNIDENTIFIED, not a real key", () => {
  const identity = getClientIdentity(
    makeRequest(null, "/api/stock/watchlist-quotes")
  );

  assertEquals(identity.identified, false);
  assertEquals(identity.key, UNIDENTIFIED_CLIENT);
  assertEquals(
    identity.source,
    "absent",
    "the shared bucket is reachable ONLY from a genuinely absent header"
  );
});

Deno.test("upstream-budget UB-07c: empty X-Forwarded-For entries do not become a second blank shared bucket", () => {
  // A misconfigured proxy emitting a trailing comma used to resolve to "",
  // which looks like a key, keys everyone to one bucket, and reports itself as
  // an identified client.
  for (const header of ["", "   ", ",", " , ", ",,,", "1.2.3.4,", "1.2.3.4, "]) {
    const identity = getClientIdentity(makeRequest(header, "/api/ub07c"));
    const label = `header ${JSON.stringify(header)}`;

    if (header.includes("1.2.3.4")) {
      assertEquals(identity.key, "ip:1.2.3.4", label);
      assertEquals(identity.identified, true, label);
      assertEquals(identity.source, "forwarded", label);
    } else {
      assert(
        identity.key !== "" && identity.key !== "ip:",
        `${label} must not produce a blank key`
      );
      assertEquals(
        identity.key,
        UNTRUSTED_CLIENT,
        `${label} is a value the CLIENT chose, so it must be metered as a ` +
          `client — not pooled with callers the runtime could not attribute`
      );
      assertEquals(identity.source, "untrusted", label);
    }
  }
});

Deno.test("upstream-budget UB-07d: a client cannot put itself in the shared bucket by forging the sentinel", () => {
  // The shared bucket may be given a much wider request allowance than one
  // user, so claiming it must be impossible. Identified keys are prefixed, so
  // no header value can collide with the sentinel.
  for (const forged of [UNIDENTIFIED_CLIENT, UNTRUSTED_CLIENT, "unknown"]) {
    const identity = getClientIdentity(makeRequest(forged, "/api/ub07d"));

    assertEquals(identity.identified, true, forged);
    assertEquals(identity.source, "forwarded", forged);
    assert(
      identity.key !== UNIDENTIFIED_CLIENT,
      `a forged ${forged} must not land in the shared-fate bucket`
    );
  }
});

// ---------------------------------------------------------------------------
// UB-07e: membership in the shared bucket is not self-selectable
//
// The regression this pins: the shared bucket is deliberately given a MUCH
// wider request allowance than one user, and identified callers are the only
// ones charged a per-client upstream budget. Both concessions used to be
// available to any client willing to send `X-Forwarded-For: ,` — the header is
// present, so Next.js's `x-forwarded-for ??= socket.remoteAddress` never fills
// in the real address, and the empty parse landed the caller in the shared
// bucket. On an unproxied deployment that was 6x the inbound allowance plus a
// complete skip of MAX_UPSTREAM_CALLS_PER_IP.
//
// Asserted through checkRateLimit rather than getClientIdentity alone, because
// the defect was about what the ALLOWANCE ends up being, not about a field.
// ---------------------------------------------------------------------------

Deno.test("upstream-budget UB-07e: an empty or comma-only X-Forwarded-For cannot buy the wider shared allowance", () => {
  const options = { maxRequests: 2, unidentifiedMaxRequests: 20 };

  for (const junk of ["", "   ", ",", " , ", ",,,", " ,, , "]) {
    // A distinct path per header value, so each junk header is measured against
    // a fresh window rather than inheriting the previous one's count.
    const path = `/api/ub07e/${encodeURIComponent(junk)}`;

    assertEquals(checkRateLimit(makeRequest(junk, path), options).allowed, true);
    assertEquals(checkRateLimit(makeRequest(junk, path), options).allowed, true);
    assertEquals(
      checkRateLimit(makeRequest(junk, path), options).allowed,
      false,
      `X-Forwarded-For ${JSON.stringify(junk)} must be capped at maxRequests ` +
        `(2), not at the shared bucket's 20`
    );
    assertEquals(
      checkRateLimit(makeRequest(junk, path), options).identified,
      true,
      `${JSON.stringify(junk)} must report identified, or the route would skip ` +
        `its per-client upstream budget for this caller`
    );
  }
});

Deno.test("upstream-budget UB-07f: junk-header callers share one bucket, and it is not the shared-fate one", () => {
  const path = "/api/ub07f";
  const options = { maxRequests: 3, unidentifiedMaxRequests: 50 };

  // Three different junk spellings, one bucket between them.
  assertEquals(checkRateLimit(makeRequest("", path), options).allowed, true);
  assertEquals(checkRateLimit(makeRequest(",", path), options).allowed, true);
  assertEquals(checkRateLimit(makeRequest(" , ", path), options).allowed, true);
  assertEquals(
    checkRateLimit(makeRequest(",,,", path), options).allowed,
    false,
    "every junk spelling must land in the same UNTRUSTED_CLIENT bucket"
  );

  // ...and exhausting it must not touch the genuinely-unattributable bucket,
  // which is the one an unproxied deployment's real users occupy.
  const shared = checkRateLimit(makeRequest(null, path), options);
  assertEquals(shared.allowed, true);
  assertEquals(
    shared.identified,
    false,
    "a request with no header at all is still the shared-fate case"
  );
});

Deno.test("upstream-budget UB-07g: sending junk is never better than sending nothing", () => {
  // The incentive test. On a Node deployment the socket fill means "send
  // nothing" resolves to a real ip: key with maxRequests; the junk header
  // suppresses that fill, so it must not come out ahead.
  const options = { maxRequests: 4, unidentifiedMaxRequests: 200 };

  const junk = getClientIdentity(makeRequest(",", "/api/ub07g"));
  const real = getClientIdentity(makeRequest("203.0.113.7", "/api/ub07g"));

  assertEquals(junk.identified, real.identified);
  assert(
    junk.key !== real.key,
    "the junk bucket must be its own bucket, not a real client's"
  );

  // Same allowance as one real client — except shared with every other junk
  // sender, which is strictly worse than having your own ip: bucket.
  for (let i = 0; i < 4; i++) {
    assertEquals(
      checkRateLimit(makeRequest(",", "/api/ub07g-limit"), options).allowed,
      true
    );
  }
  assertEquals(
    checkRateLimit(makeRequest(",", "/api/ub07g-limit"), options).allowed,
    false
  );
});

// ---------------------------------------------------------------------------
// UB-08: refunding reserved-but-unspent calls
//
// The budget is reserved BEFORE any call is made, because the allowance has to
// be agreed before work starts. A caller that then makes fewer calls than it
// reserved — the request deadline closed, an early exit, a thrown handler — has
// charged the shared key's budget for calls Finnhub never received. Without a
// refund, a slow minute silently starves every other caller of allowance that
// bought nothing.
// ---------------------------------------------------------------------------

Deno.test("upstream-budget UB-08: unspent calls are returned to the bucket", () => {
  const bucket = { key: "ub08", limit: 10 };

  const reservation = reserveUpstreamCalls([bucket], 10);
  assertEquals(reservation.granted, 10);
  assertEquals(reserveUpstreamCalls([bucket], 1).granted, 0, "budget is spent");

  // Only 4 of the 10 were actually dispatched.
  assertEquals(releaseUpstreamCalls(reservation, 6), 6);
  assertEquals(
    reserveUpstreamCalls([bucket], 10).granted,
    6,
    "the 6 calls never made must be available to the next caller"
  );
});

Deno.test("upstream-budget UB-08b: a refund is credited to every bucket the reservation charged", () => {
  const perIp = { key: "ub08b-ip", limit: 25 };
  const global = { key: "ub08b-global", limit: 30 };

  const reservation = reserveUpstreamCalls([perIp, global], 20);
  assertEquals(reservation.granted, 20);
  assertEquals(releaseUpstreamCalls(reservation, 15), 15);

  // 25 - (20 - 15) = 20 left per-IP, and 30 - 5 = 25 left globally.
  assertEquals(reserveUpstreamCalls([perIp], 25).granted, 20);
  assertEquals(reserveUpstreamCalls([global], 30).granted, 25);
});

Deno.test("upstream-budget UB-08c: a refund larger than the grant is capped at the grant", () => {
  const bucket = { key: "ub08c", limit: 10 };

  const first = reserveUpstreamCalls([bucket], 4);
  reserveUpstreamCalls([bucket], 4); // a second, unrelated caller — used = 8

  assertEquals(
    releaseUpstreamCalls(first, 999),
    4,
    "a caller must not be able to refund budget it never reserved"
  );
  assertEquals(
    reserveUpstreamCalls([bucket], 10).granted,
    6,
    "only the first reservation's 4 come back; the other caller's 4 stay spent"
  );
});

Deno.test("upstream-budget UB-08d: releasing the same reservation twice refunds nothing the second time", () => {
  const bucket = { key: "ub08d", limit: 10 };

  const first = reserveUpstreamCalls([bucket], 4);
  reserveUpstreamCalls([bucket], 4); // used = 8

  assertEquals(releaseUpstreamCalls(first, 4), 4);
  assertEquals(
    releaseUpstreamCalls(first, 4),
    0,
    "a double release — e.g. an explicit release plus a finally block — must " +
      "not mint allowance"
  );
  assertEquals(
    reserveUpstreamCalls([bucket], 10).granted,
    6,
    "used must be 4, not 0: the second release must have been a no-op"
  );
});

Deno.test("upstream-budget UB-08e: a refund is refused once the window it was charged to has rolled", () => {
  const bucket = { key: "ub08e", limit: 10 };

  withFrozenClock(1_000_000, (advance) => {
    const stale = reserveUpstreamCalls([bucket], 10);
    assertEquals(stale.granted, 10);

    // The window rolls, and a different caller opens the next one.
    advance(WINDOW_MS + 1);
    assertEquals(reserveUpstreamCalls([bucket], 3).granted, 3);

    // The late refund belongs to a window that no longer exists. Crediting it
    // to the successor would let a caller manufacture allowance by reserving
    // just before a boundary and refunding just after.
    assertEquals(
      releaseUpstreamCalls(stale, 10),
      0,
      "the return value must report what was CREDITED, not what was asked " +
        "for: no window accepted this refund, so reporting 10 would tell a " +
        "caller the opposite of the truth on the one path this guard exists " +
        "to police"
    );

    assertEquals(
      reserveUpstreamCalls([bucket], 10).granted,
      7,
      "the new window must still show the 3 it actually spent"
    );

    // The successor window is now fully spent: 3 + the 7 just taken above.
    // The reservation is nonetheless SETTLED — a 0 return means the credit
    // lapsed, never "try again" — so a retry must not find the 10 refundable.
    assertEquals(
      releaseUpstreamCalls(stale, 10),
      0,
      "a lapsed refund must not stay refundable"
    );
    assertEquals(
      reserveUpstreamCalls([bucket], 10).granted,
      0,
      "the retry must credit nothing: had it refunded 10 into the successor " +
        "window, used would be 0 and this would grant a full 10"
    );
  });
});

Deno.test("upstream-budget UB-08e2: a refund that reaches only some of its buckets still reports the amount", () => {
  // Buckets can hold windows opened at different times, so one can roll while
  // the other is still open. The still-open bucket really did get the calls
  // back, so 0 would be as wrong here as 10 was in UB-08e.
  const rolled = { key: "ub08e2-rolled", limit: 10 };
  const open = { key: "ub08e2-open", limit: 10 };

  withFrozenClock(3_000_000, (advance) => {
    // `rolled` opens its window 40s before the reservation, so it expires first.
    assertEquals(reserveUpstreamCalls([rolled], 1).granted, 1);
    advance(40_000);

    const reservation = reserveUpstreamCalls([rolled, open], 6);
    assertEquals(reservation.granted, 6);

    // Past `rolled`'s resetAt (opened at T, now T+40s+25s) but well inside
    // `open`'s (opened at T+40s, resets at T+100s).
    advance(25_000);

    assertEquals(
      releaseUpstreamCalls(reservation, 6),
      6,
      "at least one charged window was still open and received the credit"
    );
    assertEquals(
      reserveUpstreamCalls([open], 10).granted,
      10,
      "all 6 must have come back to the still-open bucket, leaving used = 0"
    );
  });
});

Deno.test("upstream-budget UB-08f: degenerate refunds are no-ops", () => {
  const bucket = { key: "ub08f", limit: 10 };
  const reservation = reserveUpstreamCalls([bucket], 6);

  for (const amount of [0, -3, NaN, Infinity]) {
    assertEquals(
      releaseUpstreamCalls(reservation, amount),
      0,
      `refund of ${amount} must credit nothing`
    );
  }
  assertEquals(reserveUpstreamCalls([bucket], 10).granted, 4);
});

Deno.test("upstream-budget UB-08g: releasing a reservation that was granted nothing is safe", () => {
  const bucket = { key: "ub08g", limit: 2 };

  reserveUpstreamCalls([bucket], 2);
  const denied = reserveUpstreamCalls([bucket], 5);

  assertEquals(denied.granted, 0);
  assertEquals(releaseUpstreamCalls(denied, 5), 0);
  assertEquals(
    reserveUpstreamCalls([bucket], 2).granted,
    0,
    "a zero grant must not be refundable into free allowance"
  );
});

// ---------------------------------------------------------------------------
// UB-09: window resets
//
// Fixed 60-second windows. Every other test in this file runs inside a single
// window, so the reset branch is only reachable with a frozen clock.
// ---------------------------------------------------------------------------

Deno.test("upstream-budget UB-09: an exhausted budget recovers in full when the window rolls", () => {
  const bucket = { key: "ub09", limit: 30 };

  withFrozenClock(2_000_000, (advance) => {
    assertEquals(reserveUpstreamCalls([bucket], 30).granted, 30);
    assertEquals(reserveUpstreamCalls([bucket], 1).granted, 0);

    // Still inside the window at 59.9s — the budget must NOT have recovered.
    advance(WINDOW_MS - 100);
    assertEquals(
      reserveUpstreamCalls([bucket], 1).granted,
      0,
      "the budget must last the whole window, not most of it"
    );

    advance(200); // now past resetAt
    assertEquals(
      reserveUpstreamCalls([bucket], 30).granted,
      30,
      "a new window starts with the full limit"
    );
  });
});

Deno.test("upstream-budget UB-09b: the sustained rate is the limit even though a boundary burst can double it", () => {
  // Documents the fixed-window caveat rather than pretending it is absent: the
  // tail of one window and the head of the next can both be spent in quick
  // succession. Callers must describe these limits as a sustained rate.
  const bucket = { key: "ub09b", limit: 30 };

  withFrozenClock(3_000_000, (advance) => {
    // One call opens the window, so the window boundary is a known instant.
    assertEquals(reserveUpstreamCalls([bucket], 1).granted, 1);

    // Spend the rest of the window's budget in its final 100ms...
    advance(WINDOW_MS - 100);
    assertEquals(reserveUpstreamCalls([bucket], 29).granted, 29);

    // ...then the whole of the next window's, 200ms later.
    advance(200);
    assertEquals(
      reserveUpstreamCalls([bucket], 30).granted,
      30,
      "59 calls inside ~200ms is inherent to fixed windows; the route comment " +
        "must not claim the limit is an instantaneous ceiling"
    );
  });
});

Deno.test("upstream-budget UB-09c: a request-limit window also resets rather than blocking forever", () => {
  const req = () => makeRequest("10.9.0.1", "/api/stock/ub09c");

  withFrozenClock(4_000_000, (advance) => {
    for (let i = 0; i < 5; i++) {
      assertEquals(checkRateLimit(req(), { maxRequests: 5 }).allowed, true);
    }
    assertEquals(checkRateLimit(req(), { maxRequests: 5 }).allowed, false);

    advance(WINDOW_MS + 1);
    assertEquals(
      checkRateLimit(req(), { maxRequests: 5 }).allowed,
      true,
      "a 429 must not be permanent"
    );
  });
});

// ---------------------------------------------------------------------------
// RL-13: the per-route request-limit override
//
// The 30/min default is sized for the house pattern of 1 request -> 1 upstream
// call. The watchlist route fans out to 20, so it passes a tighter limit.
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-13: maxRequests tightens the per-IP allowance for a fan-out route", () => {
  const ip = "10.13.0.1";
  const path = "/api/stock/rl13";

  for (let i = 0; i < 10; i++) {
    assertEquals(
      checkRateLimit(makeRequest(ip, path), { maxRequests: 10 }).allowed,
      true,
      `request ${i + 1} should be allowed`
    );
  }

  const rejected = checkRateLimit(makeRequest(ip, path), { maxRequests: 10 });
  assertEquals(rejected.allowed, false);
  assertEquals(rejected.retryAfterMs > 0, true);
});

Deno.test("ratelimit RL-13b: omitting maxRequests keeps the 30/min default for existing routes", () => {
  const ip = "10.13.0.2";
  const path = "/api/stock/rl13b";

  for (let i = 0; i < 30; i++) {
    assertEquals(checkRateLimit(makeRequest(ip, path)).allowed, true);
  }
  assertEquals(checkRateLimit(makeRequest(ip, path)).allowed, false);
});

Deno.test("ratelimit RL-13c: a non-finite maxRequests falls back to the default instead of disabling the limit", () => {
  const ip = "10.13.0.3";
  const path = "/api/stock/rl13c";

  for (let i = 0; i < 30; i++) {
    assertEquals(
      checkRateLimit(makeRequest(ip, path), { maxRequests: NaN }).allowed,
      true
    );
  }
  assertEquals(
    checkRateLimit(makeRequest(ip, path), { maxRequests: NaN }).allowed,
    false,
    "a NaN override must not fail open to an unlimited route"
  );
});

// ---------------------------------------------------------------------------
// RL-14: the shared bucket is sized as a shared bucket
//
// A limit sized for one user, applied to a bucket that may hold every visitor
// at once, is not a rate limit — it is an outage for visitor number two. The
// route opts into a wider allowance for unattributable callers; the key's
// exposure is unaffected, because the global upstream budget binds regardless
// of identity.
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-14: an unidentified caller gets the shared allowance, not one user's", () => {
  const path = "/api/stock/rl14";
  const options = { maxRequests: 2, unidentifiedMaxRequests: 5 };

  for (let i = 0; i < 5; i++) {
    const result = checkRateLimit(makeRequest(null, path), options);
    assertEquals(result.allowed, true, `request ${i + 1} should be allowed`);
    assertEquals(result.identified, false);
  }
  assertEquals(checkRateLimit(makeRequest(null, path), options).allowed, false);
});

Deno.test("ratelimit RL-14b: an identified caller still gets the tight per-user allowance", () => {
  const path = "/api/stock/rl14b";
  const options = { maxRequests: 2, unidentifiedMaxRequests: 5 };

  for (let i = 0; i < 2; i++) {
    const result = checkRateLimit(makeRequest("10.14.0.1", path), options);
    assertEquals(result.allowed, true);
    assertEquals(result.identified, true);
  }
  assertEquals(
    checkRateLimit(makeRequest("10.14.0.1", path), options).allowed,
    false,
    "the wider shared allowance must never leak to an identified client"
  );
});

Deno.test("ratelimit RL-14c: omitting unidentifiedMaxRequests leaves other routes exactly as they were", () => {
  const path = "/api/stock/rl14c";

  for (let i = 0; i < 3; i++) {
    assertEquals(
      checkRateLimit(makeRequest(null, path), { maxRequests: 3 }).allowed,
      true
    );
  }
  assertEquals(
    checkRateLimit(makeRequest(null, path), { maxRequests: 3 }).allowed,
    false,
    "the shared bucket must default to maxRequests, not to something wider"
  );
});

Deno.test("ratelimit RL-14d: identified and unidentified callers occupy different buckets", () => {
  const path = "/api/stock/rl14d";
  const options = { maxRequests: 2, unidentifiedMaxRequests: 2 };

  assertEquals(checkRateLimit(makeRequest(null, path), options).allowed, true);
  assertEquals(checkRateLimit(makeRequest(null, path), options).allowed, true);
  assertEquals(checkRateLimit(makeRequest(null, path), options).allowed, false);

  assertEquals(
    checkRateLimit(makeRequest("10.14.0.2", path), options).allowed,
    true,
    "exhausting the shared bucket must not 429 an identified client"
  );
});

Deno.test("ratelimit RL-14e: a caller-supplied identity is used verbatim, so both gates meter one client", () => {
  const path = "/api/stock/rl14e";
  const identity: ClientIdentity = {
    key: "ip:10.14.0.9",
    identified: true,
    source: "forwarded",
  };
  // The header says one thing, the explicit identity says another: the route
  // resolves the identity once and passes it to both the limiter and its own
  // budget, so the limiter must honour what it was given.
  const request = makeRequest("10.14.0.8", path);

  assertEquals(checkRateLimit(request, { maxRequests: 1, identity }).allowed, true);
  assertEquals(checkRateLimit(request, { maxRequests: 1, identity }).allowed, false);
  assertEquals(
    checkRateLimit(makeRequest("10.14.0.8", path), { maxRequests: 1 }).allowed,
    true,
    "the header-derived bucket must be untouched"
  );
});

// ---------------------------------------------------------------------------
// UB-11: the deployment-wide budget survives key pressure
//
// `upstreamWindows` evicts FIFO once it holds MAX_IP_ENTRIES (10,000) keys, and
// Map insertion order put the global budget key near the very front — the route
// iterates its buckets as [perIP, global], so the global key was created on the
// first request and evicted on roughly the ten-thousandth distinct one. Evicting
// a per-caller window costs one caller a stale count; evicting the global window
// resets the ONLY ceiling that does not depend on being able to identify the
// caller, and does so precisely when a caller is manufacturing tens of thousands
// of distinct keys.
//
// Deliberately placed last in this file. It leaves the module-scoped window map
// at its cap, which would evict earlier tests' keys out from under them.
// ---------------------------------------------------------------------------

/** Mirrors MAX_IP_ENTRIES in lib/ratelimit.ts, which is not exported. */
const MAX_WINDOW_ENTRIES = 10_000;

Deno.test("upstream-budget UB-11: a pinned deployment-wide budget is never the eviction victim", () => {
  const globalBucket = { key: "ub11:global", limit: 30, pinned: true };

  // Spend 1 of 30, so a surviving window is distinguishable from a fresh one.
  assertEquals(reserveUpstreamCalls([globalBucket], 1).granted, 1);

  // Far more distinct per-caller keys than the map can hold — the shape of a
  // caller rotating X-Forwarded-For values. Each one is inserted at the back,
  // so eviction walks forward from the front, straight over the global key.
  for (let i = 0; i < MAX_WINDOW_ENTRIES + 2_000; i++) {
    reserveUpstreamCalls([{ key: `ub11:rotating:${i}`, limit: 5 }], 1);
  }

  assertEquals(
    reserveUpstreamCalls([globalBucket], 30).granted,
    29,
    "the global budget must remember the 1 call it already spent — an evicted " +
      "key would open a fresh window and hand back the full 30"
  );
});

Deno.test("upstream-budget UB-11b: pinning protects the budget, it does not freeze it", () => {
  const bucket = { key: "ub11b:global", limit: 10, pinned: true };

  withFrozenClock(4_000_000, (advance) => {
    assertEquals(reserveUpstreamCalls([bucket], 10).granted, 10);
    assertEquals(
      reserveUpstreamCalls([bucket], 1).granted,
      0,
      "a pinned budget must still bind while its window is open"
    );

    advance(WINDOW_MS + 1);
    assertEquals(
      reserveUpstreamCalls([bucket], 10).granted,
      10,
      "a pinned budget must still roll over on schedule"
    );
  });
});

Deno.test("upstream-budget UB-11c: an unpinned key is still evicted, so the cap still holds", () => {
  // The counterpart to UB-11: pinning must be opt-in, or the map would grow
  // without bound and the cap would be decorative. UB-11 above has already
  // filled the map past MAX_WINDOW_ENTRIES, so the next insert evicts.
  const victim = { key: "ub11c:victim", limit: 4 };

  assertEquals(reserveUpstreamCalls([victim], 4).granted, 4);
  assertEquals(
    reserveUpstreamCalls([victim], 1).granted,
    0,
    "the victim's window is open and fully spent"
  );

  for (let i = 0; i < MAX_WINDOW_ENTRIES + 100; i++) {
    reserveUpstreamCalls([{ key: `ub11c:rotating:${i}`, limit: 5 }], 1);
  }

  assertEquals(
    reserveUpstreamCalls([victim], 4).granted,
    4,
    "an unpinned window must be evictable — otherwise nothing bounds the map"
  );
});
