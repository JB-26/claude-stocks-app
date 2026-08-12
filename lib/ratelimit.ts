const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const MAX_IP_ENTRIES = 10_000;
const ipWindows = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the rate-limit window resets. Only meaningful when `allowed` is false. */
  retryAfterMs: number;
  /**
   * False ONLY when the request was counted against the shared-fate bucket —
   * i.e. when the runtime supplied no address at all (see `getClientIdentity`).
   *
   * Routes that keep additional PER-CLIENT budgets must check this: a per-client
   * budget applied to the shared bucket is not a per-client budget at all, it is
   * a whole-deployment budget wearing a per-client number.
   *
   * A client that sends a syntactically present but useless X-Forwarded-For is
   * reported as `true` here, not `false`. See `ClientIdentity.identified`.
   */
  identified: boolean;
}

/** Per-call overrides for `checkRateLimit`. */
export interface RateLimitOptions {
  /**
   * Requests allowed per IP per route per window. Defaults to MAX_REQUESTS (30).
   *
   * Routes that fan out to more than one upstream call per request should pass
   * a smaller value: the default is sized for 1 request → 1 upstream call, and
   * a fan-out route multiplies it by its fan-out factor.
   */
  maxRequests?: number;
  /**
   * Requests allowed for the shared UNIDENTIFIED bucket per window. Defaults to
   * `maxRequests`, i.e. unchanged behaviour for routes that do not opt in.
   *
   * A route should raise this whenever `maxRequests` is sized for ONE user.
   * The unidentified bucket is not one user — it is every caller the deployment
   * could not tell apart — so charging them a single user's allowance turns a
   * fairness control into a whole-deployment outage. See `getClientIdentity`.
   *
   * Safe to raise well above `maxRequests` only because membership in that
   * bucket is a property of the deployment (`source: "absent"` — the runtime
   * supplied no address for ANYONE) rather than of the request. A caller that
   * sends a junk X-Forwarded-For is charged `maxRequests` against
   * `UNTRUSTED_CLIENT` and never reaches this number.
   */
  unidentifiedMaxRequests?: number;
  /**
   * A pre-computed identity, so a caller that also needs the identity for its
   * own budgets provably meters both against the same client rather than
   * parsing the header twice and hoping the two agree.
   */
  identity?: ClientIdentity;
}

// ---------------------------------------------------------------------------
// Client identity
// ---------------------------------------------------------------------------

/**
 * Bucket key for callers the RUNTIME could not attribute, because it supplied
 * no forwarded address at all.
 *
 * Carries an `unidentified:` prefix that a header value can never produce,
 * because identified callers are keyed as `ip:<address>`. Without the prefixing
 * a client on an unproxied deployment could send `x-forwarded-for: unknown`,
 * land itself in the shared bucket on purpose, and claim whatever wider
 * allowance that bucket is given.
 *
 * Membership is a property of the DEPLOYMENT, not of the request: see
 * `getClientIdentity` for why a request can never opt into this bucket.
 */
export const UNIDENTIFIED_CLIENT = "unidentified:shared";

/**
 * Bucket key for callers that sent an X-Forwarded-For carrying no usable
 * address at all — `""`, `"   "`, `","`, `",,,"`.
 *
 * Deliberately NOT `UNIDENTIFIED_CLIENT`. These two states used to be one, and
 * conflating them was an escape hatch: a client that sent a bare comma reached
 * the shared bucket on purpose and collected both of its concessions — the
 * wider `unidentifiedMaxRequests` allowance and the exemption from per-client
 * upstream budgets — on any deployment without a proxy that appends. Sending
 * the header is what suppresses Next.js's `??=` socket fill, so the trick works
 * precisely where the socket address would otherwise have identified the
 * caller.
 *
 * Callers here are metered as ONE client (`identified: true`) against this one
 * constant key. That is strictly tighter than the `ip:` bucket a well-formed
 * header would have bought, so there is no longer any value in sending junk.
 */
export const UNTRUSTED_CLIENT = "unidentified:untrusted";

/** Where a `ClientIdentity.key` came from. */
export type ClientIdentitySource =
  /** The last X-Forwarded-For entry — an address, trustworthy only behind a proxy that appends. */
  | "forwarded"
  /** No X-Forwarded-For header at all. The only genuinely unattributable case. */
  | "absent"
  /** X-Forwarded-For was present but held no usable address. Client-chosen, so client-charged. */
  | "untrusted";

/** Who a request is being metered as. */
export interface ClientIdentity {
  /** Rate-limit bucket key. `UNIDENTIFIED_CLIENT` when `identified` is false. */
  key: string;
  /**
   * Whether this request must be metered as ONE client — i.e. whether the tight
   * per-client request allowance and any per-client upstream budget apply.
   *
   * False for exactly one `source`: `"absent"`. That is the only state a client
   * cannot select for itself, because it is the absence of a header the runtime
   * fills in whenever it can (Next.js's socket `??=`) and a proxy always
   * appends to. So a deployment where this is false is one where NOBODY can be
   * attributed, which is what makes the shared bucket's wider allowance safe to
   * grant.
   *
   * Note the deliberate asymmetry with `key`: `source: "untrusted"` reports
   * `identified: true` while its key names a bucket rather than a client. The
   * flag answers "may this caller be charged a single client's allowance?", and
   * for a caller that chose to be unattributable the answer must be yes — the
   * alternative is letting it choose the wider one. Routes that need to know
   * whether the key is a real address must read `source`, not this flag.
   */
  identified: boolean;
  /** How the key was derived. The discriminator for how much to trust `key`. */
  source: ClientIdentitySource;
}

/**
 * Resolves the client identity used as the rate-limit key.
 *
 * Uses the LAST entry in X-Forwarded-For, not the first. The first entry is
 * client-supplied and trivially spoofable. A trusted reverse proxy always
 * appends the real connecting IP at the end, so the last entry is the one the
 * proxy observed and cannot be forged by the client.
 *
 * Three outcomes, and the difference between the last two is the whole point of
 * this function:
 *
 * - An entry was read → `ip:<address>`, identified.
 * - NO header at all → `UNIDENTIFIED_CLIENT`, not identified. Every
 *   unattributable visitor shares one bucket, so a limit sized for one user
 *   becomes a limit for the entire deployment; routes must size the shared
 *   bucket deliberately (`unidentifiedMaxRequests`) or skip their per-client
 *   budgets rather than apply them to everyone at once.
 * - A header that parsed to NOTHING → `UNTRUSTED_CLIENT`, identified. The
 *   caller supplied the value, so the caller is charged for it as one client.
 *
 * That last split is a fix, not a nicety. Next.js fills the header in from the
 * Node socket (`req.headers['x-forwarded-for'] ??= socket.remoteAddress`), so a
 * plain `next start` usually does produce an address — but `??=` only fills a
 * MISSING header. Treating an empty-but-present header as "no header" therefore
 * handed any client a one-byte opt-in (`X-Forwarded-For: ,`) into the shared
 * bucket's concessions on exactly the deployments where the socket address
 * would otherwise have pinned it down. Empty segments are still dropped before
 * the last entry is taken, so a misconfigured proxy's trailing comma
 * ("1.2.3.4, ") still resolves to `ip:1.2.3.4` rather than to a blank key.
 *
 * Treat an identified `source: "forwarded"` key as trustworthy only behind a
 * proxy that appends; non-Node adapters make no guarantee at all.
 *
 * Exported so routes that keep additional per-client budgets (see
 * `reserveUpstreamCalls`) key them off exactly the same identity.
 */
export function getClientIdentity(request: Request): ClientIdentity {
  const xff = request.headers.get("x-forwarded-for");
  // `=== null` and not a truthiness test: "" is a header the CLIENT sent, and
  // must not be indistinguishable from one it did not send.
  if (xff === null) {
    return { key: UNIDENTIFIED_CLIENT, identified: false, source: "absent" };
  }

  const last = xff
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .at(-1);

  return last !== undefined
    ? { key: `ip:${last}`, identified: true, source: "forwarded" }
    : { key: UNTRUSTED_CLIENT, identified: true, source: "untrusted" };
}

/**
 * The rate-limit key for a request. Thin wrapper over `getClientIdentity` for
 * callers that only need the bucket key; prefer the full identity when the
 * `identified` flag would change what the caller does.
 */
export function getClientIp(request: Request): string {
  return getClientIdentity(request).key;
}

/**
 * Drops the oldest evictable entry when a window map hits its size cap.
 *
 * Eviction is FIFO over Map insertion order, which for a per-caller map is the
 * right victim — the oldest key is the least recently created window. But the
 * same map also holds DEPLOYMENT-WIDE budget keys, and those are inserted early
 * and never again, so plain FIFO makes the whole-deployment ceiling the first
 * thing thrown away under key pressure. Evicting a per-caller window costs one
 * caller a stale count; evicting the global budget window resets the only
 * protection that does not depend on identifying the caller, and does so
 * exactly when 10,000 distinct keys are in play.
 *
 * `pinned` keys are therefore skipped and the next-oldest evictable key is
 * taken instead. The scan is bounded in practice by `MAX_PINNED_KEYS` being
 * tiny relative to the cap, so it finds a victim within a couple of steps.
 */
function evictOldestIfFull(
  map: Map<string, unknown>,
  pinned?: ReadonlySet<string>
): void {
  if (map.size < MAX_IP_ENTRIES) return;

  for (const key of map.keys()) {
    if (pinned?.has(key)) continue;
    map.delete(key);
    return;
  }
  // Every key pinned: bounded by MAX_PINNED_KEYS, so the map grows by one
  // rather than discarding a protection. Unreachable while that cap holds.
}

/**
 * Budget keys that must survive eviction — see `evictOldestIfFull`.
 *
 * Capped, and populated only from `UpstreamBudgetBucket.pinned`. The cap is
 * defence against the one mistake that would turn this into a leak: pinning a
 * key derived from request data, which would let a caller grow the set without
 * bound AND make its own budget unevictable. Pin only constant keys.
 */
const pinnedUpstreamKeys = new Set<string>();
const MAX_PINNED_KEYS = 32;

function pinUpstreamKey(key: string): void {
  if (pinnedUpstreamKeys.size >= MAX_PINNED_KEYS) return;
  pinnedUpstreamKeys.add(key);
}

/** Normalises a caller-supplied limit, failing back to `fallback` if unusable. */
function normaliseLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value as number)) : fallback;
}

/**
 * Checks whether the request is within the rate limit.
 * Keyed by client identity + pathname. 30 requests per client per route per 60
 * seconds by default; pass `options.maxRequests` to tighten it for a fan-out
 * route, and `options.unidentifiedMaxRequests` to size the shared bucket that
 * unattributable callers all count against.
 *
 * Returns a `RateLimitResult` with an `allowed` flag, a `retryAfterMs` value
 * that route handlers can convert to a `Retry-After` header on 429 responses,
 * and an `identified` flag describing which kind of bucket was charged.
 */
export function checkRateLimit(
  request: Request,
  options: RateLimitOptions = {}
): RateLimitResult {
  const identity = options.identity ?? getClientIdentity(request);
  const perClientMax = normaliseLimit(options.maxRequests, MAX_REQUESTS);
  const maxRequests = identity.identified
    ? perClientMax
    : normaliseLimit(options.unidentifiedMaxRequests, perClientMax);

  const pathname = new URL(request.url).pathname;
  const key = `${identity.key}:${pathname}`;
  const now = Date.now();
  const window = ipWindows.get(key);

  if (!window || now > window.resetAt) {
    evictOldestIfFull(ipWindows);
    ipWindows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterMs: 0, identified: identity.identified };
  } else if (window.count >= maxRequests) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, window.resetAt - now),
      identified: identity.identified,
    };
  } else {
    window.count++;
    return { allowed: true, retryAfterMs: 0, identified: identity.identified };
  }
}

// ---------------------------------------------------------------------------
// Upstream call budgets
//
// `checkRateLimit` bounds inbound REQUESTS. It cannot bound outbound calls to
// the single shared Finnhub API key, because a fan-out route turns one inbound
// request into N upstream calls. These budgets meter the upstream side
// directly, so the worst case is a function of the budget rather than of
// (requests × fan-out).
//
// Fixed 60s windows, matching WINDOW_MS above and the free tier's per-minute
// quota. Module-scoped and per-instance, exactly like `ipWindows` — good enough
// for a single-instance deployment, and the same caveat applies to both.
//
// FIXED-WINDOW CAVEAT: a limit of N per window bounds the SUSTAINED rate at
// N/minute, not any arbitrary 60-second span. A burst that spends the tail of
// one window and the head of the next can place up to 2N calls in a very short
// period. This is inherent to fixed windows and is shared with `checkRateLimit`
// above; callers must describe their limits as a sustained rate rather than as
// an instantaneous ceiling.
// ---------------------------------------------------------------------------

const upstreamWindows = new Map<string, { used: number; resetAt: number }>();

/** One metered budget: a window key and the number of calls it allows per window. */
export interface UpstreamBudgetBucket {
  key: string;
  /** Maximum upstream calls this key may cause per 60s window. */
  limit: number;
  /**
   * Exempts this key from FIFO eviction. Set it on deployment-wide budgets,
   * whose whole job is to hold when a caller is producing thousands of distinct
   * keys — the exact condition that triggers eviction.
   *
   * Only ever set it on a CONSTANT key. A pinned key derived from request data
   * would let a caller both grow the pin set and make its own budget
   * unevictable; `pinUpstreamKey`'s cap bounds the damage, it does not excuse
   * it.
   */
  pinned?: boolean;
}

/**
 * A completed reservation. Hand this back to `releaseUpstreamCalls` for any
 * granted call the caller ends up not making.
 *
 * It carries the identity of the exact windows it was charged to, so a refund
 * can never be credited into a window that has since rolled over — that would
 * hand out allowance the new window never spent.
 */
export interface UpstreamReservation {
  /** Calls granted, 0..requested. */
  readonly granted: number;
  /** The windows charged, with the `resetAt` each had at reservation time. */
  readonly windows: readonly { key: string; resetAt: number }[];
  /** Calls already refunded. Bounds the total refund to `granted`. */
  released: number;
}

function remainingInBucket(bucket: UpstreamBudgetBucket, now: number): number {
  const limit = Number.isFinite(bucket.limit)
    ? Math.max(0, Math.floor(bucket.limit))
    : 0;
  const window = upstreamWindows.get(bucket.key);
  if (!window || now > window.resetAt) return limit;
  return Math.max(0, limit - window.used);
}

/** A reservation that was granted nothing and has nothing to refund. */
function emptyReservation(): UpstreamReservation {
  return { granted: 0, windows: [], released: 0 };
}

/**
 * Reserves up to `requested` upstream calls against every bucket at once and
 * returns a reservation describing how many were granted (0..requested).
 *
 * All buckets must have room: the grant is the minimum of `requested` and each
 * bucket's remaining allowance, and that same amount is deducted from all of
 * them. Checking and deducting in one call keeps the buckets consistent — a
 * peek-then-commit API would waste allowance from the buckets that had room
 * whenever a different bucket turned out to be the binding constraint.
 *
 * Callers must treat a partial grant as normal, not as an error: fetch the
 * granted number of items and degrade the rest. Callers must also release any
 * granted call they do not end up making — see `releaseUpstreamCalls`.
 */
export function reserveUpstreamCalls(
  buckets: readonly UpstreamBudgetBucket[],
  requested: number
): UpstreamReservation {
  if (!Number.isFinite(requested)) return emptyReservation();

  // Pinned BEFORE the early return below, so a deployment-wide budget is
  // protected from the moment it is first consulted rather than only on the
  // requests that happen to be granted something.
  for (const bucket of buckets) {
    if (bucket.pinned) pinUpstreamKey(bucket.key);
  }

  const now = Date.now();
  let granted = Math.max(0, Math.floor(requested));

  for (const bucket of buckets) {
    granted = Math.min(granted, remainingInBucket(bucket, now));
    if (granted === 0) return emptyReservation();
  }

  const windows: { key: string; resetAt: number }[] = [];

  for (const bucket of buckets) {
    const window = upstreamWindows.get(bucket.key);
    if (!window || now > window.resetAt) {
      evictOldestIfFull(upstreamWindows, pinnedUpstreamKeys);
      const fresh = { used: granted, resetAt: now + WINDOW_MS };
      upstreamWindows.set(bucket.key, fresh);
      windows.push({ key: bucket.key, resetAt: fresh.resetAt });
    } else {
      window.used += granted;
      windows.push({ key: bucket.key, resetAt: window.resetAt });
    }
  }

  return { granted, windows, released: 0 };
}

/**
 * Returns `unused` reserved-but-unspent calls to the buckets they were charged
 * to, and reports how many were actually credited back.
 *
 * The return value is 0 whenever nothing reached a bucket — including the case
 * where the refund was refundable but every window it was charged to has since
 * rolled, which credits nothing. It used to report the full amount there,
 * claiming allowance had been returned when none had; a caller logging or
 * metering the result would have been told the opposite of the truth exactly on
 * the boundary-crossing path this function exists to police. A partial credit
 * (some buckets' windows rolled, others still open) reports the full amount,
 * because that is what each still-open bucket received.
 *
 * Note that the reservation is settled either way — see `released` below — so a
 * 0 return means "the credit lapsed", never "try again".
 *
 * Reservation happens BEFORE the calls are made, because the budget has to be
 * agreed before any work starts. A caller that then makes fewer calls than it
 * reserved — a deadline reached, an early exit, a thrown handler — has spent
 * budget on calls that never touched the upstream API. Over a slow minute that
 * silently starves every other caller of allowance nothing was bought with.
 *
 * Three things it deliberately refuses to do:
 * - Refund more than was granted, however many times it is called: the running
 *   `released` total caps the lifetime refund at `granted`, so a double-release
 *   (or a `finally` that runs after an explicit release) is a no-op rather than
 *   free allowance.
 * - Credit a window that has rolled since the reservation. The charge lapsed
 *   with the old window; adding credit to its successor would let a caller
 *   manufacture allowance by reserving just before a boundary and refunding
 *   just after. Windows are matched on `resetAt`, so a same-key window created
 *   after a roll is correctly treated as a different window.
 * - Drive a bucket below zero, even if some other path has already reset it.
 */
export function releaseUpstreamCalls(
  reservation: UpstreamReservation,
  unused: number
): number {
  if (!Number.isFinite(unused)) return 0;

  const refundable = Math.max(0, reservation.granted - reservation.released);
  const refund = Math.min(Math.max(0, Math.floor(unused)), refundable);
  if (refund === 0) return 0;

  // Recorded whether or not any window still accepts the credit: the
  // reservation is settled either way, and not recording it would let a
  // repeated call refund the same tokens into a window that has meanwhile
  // become eligible again.
  reservation.released += refund;

  const now = Date.now();
  let creditedAnyWindow = false;

  for (const { key, resetAt } of reservation.windows) {
    const window = upstreamWindows.get(key);
    if (!window || window.resetAt !== resetAt || now > window.resetAt) continue;
    window.used = Math.max(0, window.used - refund);
    creditedAnyWindow = true;
  }

  return creditedAnyWindow ? refund : 0;
}
