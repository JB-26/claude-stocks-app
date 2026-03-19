const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const MAX_IP_ENTRIES = 10_000;
const ipWindows = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the rate-limit window resets. Only meaningful when `allowed` is false. */
  retryAfterMs: number;
}

/**
 * Checks whether the request is within the rate limit.
 * Keyed by IP + pathname. 30 requests per IP per route per 60 seconds.
 *
 * Returns a `RateLimitResult` with an `allowed` flag and a `retryAfterMs` value
 * that route handlers can convert to a `Retry-After` header on 429 responses.
 */
export function checkRateLimit(request: Request): RateLimitResult {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const pathname = new URL(request.url).pathname;
  const key = `${ip}:${pathname}`;
  const now = Date.now();
  const window = ipWindows.get(key);

  if (!window || now > window.resetAt) {
    if (ipWindows.size >= MAX_IP_ENTRIES) {
      const firstKey = ipWindows.keys().next().value;
      if (firstKey !== undefined) ipWindows.delete(firstKey);
    }
    ipWindows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterMs: 0 };
  } else if (window.count >= MAX_REQUESTS) {
    return { allowed: false, retryAfterMs: Math.max(0, window.resetAt - now) };
  } else {
    window.count++;
    return { allowed: true, retryAfterMs: 0 };
  }
}
