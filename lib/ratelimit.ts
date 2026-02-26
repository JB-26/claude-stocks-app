const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const MAX_IP_ENTRIES = 10_000;
const ipWindows = new Map<string, { count: number; resetAt: number }>();

/**
 * Returns true if the request is within the rate limit, false if it should be rejected.
 * Keyed by IP + pathname. 30 requests per IP per route per 60 seconds.
 */
export function checkRateLimit(request: Request): boolean {
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
    return true;
  } else if (window.count >= MAX_REQUESTS) {
    return false;
  } else {
    window.count++;
    return true;
  }
}
