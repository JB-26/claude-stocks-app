import { NextResponse } from "next/server";
import { getQuote } from "@/lib/finnhub/client";
import { getCached, setCached } from "@/lib/cache";
import { checkRateLimit } from "@/lib/ratelimit";
import type { TickerMover } from "@/lib/finnhub/types";

const MOVERS_TTL_MS = 60_000; // 60 seconds — shared across all callers
const CACHE_KEY = "movers:snapshot";

/**
 * Major US tickers to include in the ticker tape.
 * These are hardcoded; changes require a code deploy.
 * The list is intentionally broad: large-caps, ETFs, and a finance blue-chip.
 */
const TICKERS: readonly string[] = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "AMZN",
  "TSLA",
  "META",
  "NVDA",
  "SPY",
  "QQQ",
  "BRK.B",
  "JPM",
  "V",
  "NFLX",
  "AMD",
] as const;

export async function GET(request: Request): Promise<NextResponse> {
  const rateLimit = checkRateLimit(request);
  if (!rateLimit.allowed) {
    const retryAfterSeconds = Math.ceil(rateLimit.retryAfterMs / 1000);
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    );
  }

  // Return cached snapshot if still fresh — all visitors share the same result.
  const cached = getCached<TickerMover[]>(CACHE_KEY);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    // Finnhub free tier does not offer a batch-quote endpoint; call sequentially.
    // 14 tickers per request, cached for 60s, well within 30 req/IP/route/min.
    const results = await Promise.allSettled(
      TICKERS.map(async (symbol): Promise<TickerMover> => {
        const raw = await getQuote(symbol);
        return {
          symbol,
          price: raw.c,
          change: raw.d,
          changePercent: raw.dp,
        };
      })
    );

    const movers: TickerMover[] = results
      .filter(
        (r): r is PromiseFulfilledResult<TickerMover> => r.status === "fulfilled"
      )
      .map((r) => r.value)
      // Filter out any tickers that returned zero price (stale/invalid data)
      .filter((m) => m.price > 0);

    setCached(CACHE_KEY, movers, MOVERS_TTL_MS);
    return NextResponse.json(movers);
  } catch (err) {
    console.error("[/api/stock/movers]", err);
    return NextResponse.json(
      { error: "Failed to fetch movers" },
      { status: 500 }
    );
  }
}
