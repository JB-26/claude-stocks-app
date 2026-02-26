import { NextResponse } from "next/server";
import { getQuote } from "@/lib/finnhub/client";
import { getCached, setCached } from "@/lib/cache";
import { checkRateLimit } from "@/lib/ratelimit";
import { isMarketOpen } from "@/lib/utils";
import type { QuoteResponse } from "@/lib/finnhub/types";

const QUOTE_TTL_MS = 60_000; // 60 seconds
const SYMBOL_RE = /^[A-Z]{1,10}$/;

export async function GET(request: Request) {
  if (!checkRateLimit(request)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol") ?? "";

  if (!SYMBOL_RE.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  const cacheKey = `quote:${symbol}`;
  const cached = getCached<QuoteResponse>(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const raw = await getQuote(symbol);

    const response: QuoteResponse = {
      c: raw.c,
      d: raw.d,
      dp: raw.dp,
      h: raw.h,
      l: raw.l,
      o: raw.o,
      pc: raw.pc,
      t: raw.t,
      isMarketOpen: isMarketOpen(),
    };

    setCached(cacheKey, response, QUOTE_TTL_MS);
    return NextResponse.json(response);
  } catch (err) {
    console.error("[/api/stock/quote]", err);
    return NextResponse.json(
      { error: "Failed to fetch quote" },
      { status: 500 }
    );
  }
}
