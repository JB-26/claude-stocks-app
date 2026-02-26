import { NextResponse } from "next/server";
import { getHistoricalCandles } from "@/lib/yahoo";
import { getCached, setCached } from "@/lib/cache";
import { checkRateLimit } from "@/lib/ratelimit";
import type { CandlesResponse, ChartRange } from "@/lib/finnhub/types";

const CANDLES_TTL_MS = 60_000; // 60 seconds
const SYMBOL_RE = /^[A-Z]{1,10}$/;
const VALID_RANGES: ChartRange[] = ["1M", "3M", "1Y"];

export async function GET(request: Request) {
  if (!checkRateLimit(request)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol") ?? "";
  const range = searchParams.get("range") ?? "";

  if (!SYMBOL_RE.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  if (!VALID_RANGES.includes(range as ChartRange)) {
    return NextResponse.json({ error: "Invalid range" }, { status: 400 });
  }

  const cacheKey = `candles:${symbol}:${range}`;
  const cached = getCached<CandlesResponse>(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const response = await getHistoricalCandles(symbol, range as ChartRange);
    setCached(cacheKey, response, CANDLES_TTL_MS);
    return NextResponse.json(response);
  } catch (err) {
    console.error("[/api/stock/candles]", err);
    return NextResponse.json(
      { error: "Failed to fetch candles" },
      { status: 500 }
    );
  }
}
