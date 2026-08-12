// ---------------------------------------------------------------------------
// Concurrency — bounded parallel mapping over a list of items
//
// Deliberately free of Next.js and Finnhub imports so it can be unit-tested in
// plain `deno test` without any mocking, matching the pattern used by
// lib/utils.ts and lib/session.ts.
// ---------------------------------------------------------------------------

/**
 * Normalises a caller-supplied concurrency limit into a usable worker count.
 *
 * Anything that is not a finite number — `NaN`, `Infinity`, `-Infinity`, and
 * (from untyped JavaScript callers) `undefined`/`null` — is treated as a
 * programming error and clamped to 1 rather than to `total`.
 *
 * This fails CLOSED on purpose. The only reason this helper exists is to bound
 * upstream fan-out onto a shared, rate-limited API key; interpreting a garbage
 * limit as "unbounded" would defeat its sole purpose at exactly the moment
 * something is already wrong. Sequential execution is slow but never harmful.
 *
 * Finite values are floored and clamped to `[1, total]`, so a limit larger than
 * the item count never spawns idle workers.
 */
function normaliseLimit(limit: number, total: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.min(total, Math.max(1, Math.floor(limit)));
}

/**
 * Maps `fn` over `items` with at most `limit` calls in flight at any moment.
 *
 * Contract:
 * - Exactly one settled result per input item, in the same order as `items`,
 *   regardless of which item resolved first.
 * - Settled semantics: a rejection for one item never aborts or blocks the
 *   others (the same guarantee `Promise.allSettled` gives, but bounded). A
 *   synchronous throw from `fn` is captured as a rejected result too.
 * - An empty `items` array resolves to `[]` without invoking `fn` at all.
 * - A non-positive, fractional, or non-finite `limit` still produces one result
 *   per item — see `normaliseLimit`.
 *
 * Implementation: a worker pool. `limit` workers pull from a shared cursor and
 * immediately take the next item when their current one settles, so `limit`
 * calls stay in flight until the queue drains.
 *
 * This is deliberately NOT chunk-and-await-per-chunk. Chunking makes total time
 * the sum of per-chunk maxima, so a single slow item stalls every later chunk
 * and the average in-flight count collapses towards 1. With 20 watchlist
 * symbols behind one slow upstream call, that is the difference between one
 * timeout of latency and four.
 */
export async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const total = items.length;
  if (total === 0) return [];

  const results = new Array<PromiseSettledResult<R>>(total);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= total) return;
      try {
        // `await fn(...)` inside the try also captures a synchronous throw.
        results[index] = { status: "fulfilled", value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = normaliseLimit(limit, total);
  // Workers never reject — every error is captured into `results` above — so
  // Promise.all here can only settle once the queue is fully drained.
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
