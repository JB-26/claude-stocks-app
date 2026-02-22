import { NextResponse } from "next/server";
import { searchSymbols } from "@/lib/finnhub/client";
import { getCached, setCached } from "@/lib/cache";
import type { SearchResult } from "@/lib/finnhub/types";

// MIC codes for US-listed exchanges
const US_MIC_CODES = new Set([
  "XNAS", // NASDAQ
  "XNYS", // NYSE
  "XASE", // NYSE American (AMEX)
  "XARCA", // NYSE Arca
  "BATS", // CBOE BZX
  "EDGA", // CBOE EDGA
  "EDGX", // CBOE EDGX
  "IEXG", // IEX
  "XCIS", // National Stock Exchange
  "XBOS", // NASDAQ BX
  "XPHL", // NASDAQ PHLX
  "MEMX", // Members Exchange
  "LTSE", // Long-Term Stock Exchange
]);

const SEARCH_TTL_MS = 60_000; // 60 seconds

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("q") ?? "";

  // Sanitize: only allow URL-safe search characters
  const query = raw.replace(/[^A-Za-z0-9 .\-&]/g, "").trim();

  if (query.length < 1) {
    return NextResponse.json({ results: [] });
  }

  const cacheKey = `search:${query.toLowerCase()}`;
  const cached = getCached<SearchResult[]>(cacheKey);
  if (cached) {
    return NextResponse.json({ results: cached });
  }

  try {
    const data = await searchSymbols(query);

    const results: SearchResult[] = data.result
      .filter((r) => {
        if (r.type !== "Common Stock") return false;
        // When mic is present, use it; otherwise fall back to symbol pattern.
        // US tickers are 1–5 uppercase letters (e.g. AAPL, BRK, TSLA).
        if (r.mic) return US_MIC_CODES.has(r.mic);
        return /^[A-Z]{1,5}$/.test(r.symbol);
      })
      .slice(0, 10)
      .map((r) => ({
        symbol: r.symbol,
        displaySymbol: r.displaySymbol,
        description: r.description,
      }));

    setCached(cacheKey, results, SEARCH_TTL_MS);
    return NextResponse.json({ results });
  } catch (err) {
    console.error("[/api/stock/search]", err);
    return NextResponse.json(
      { error: "Failed to fetch search results" },
      { status: 500 }
    );
  }
}
