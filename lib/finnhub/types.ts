// ---------------------------------------------------------------------------
// Raw Finnhub API response shapes
// These match exactly what Finnhub returns over the wire.
// ---------------------------------------------------------------------------

export interface FinnhubSearchResult {
  description: string;   // e.g. "APPLE INC"
  displaySymbol: string; // e.g. "AAPL"
  symbol: string;        // e.g. "AAPL"
  type: string;          // e.g. "Common Stock"
  mic?: string;          // Market Identifier Code, e.g. "XNAS" (not always present)
}

export interface FinnhubSearchResponse {
  count: number;
  result: FinnhubSearchResult[];
}

export interface FinnhubQuote {
  c: number;  // current price
  d: number;  // change
  dp: number; // percent change
  h: number;  // high of the day
  l: number;  // low of the day
  o: number;  // open price
  pc: number; // previous close
  t: number;  // Unix timestamp of last update
}

export interface FinnhubCandles {
  c: number[]; // close prices
  h: number[]; // high prices
  l: number[]; // low prices
  o: number[]; // open prices
  s: string;   // status — "ok" or "no_data"
  t: number[]; // Unix timestamps
  v: number[]; // volumes
}

export interface FinnhubNewsArticle {
  category: string;
  datetime: number; // Unix timestamp
  headline: string;
  id: number;
  image: string;
  related: string;  // ticker symbol
  source: string;
  summary: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Internal app types
// These are what the Next.js Route Handlers return to the browser.
// ---------------------------------------------------------------------------

/** A single search result returned by GET /api/stock/search */
export interface SearchResult {
  symbol: string;
  displaySymbol: string;
  description: string;
}

/**
 * Quote data returned by GET /api/stock/quote.
 * isMarketOpen is computed server-side based on NYSE trading hours.
 */
export interface QuoteResponse {
  c: number;           // current price
  d: number;           // change
  dp: number;          // percent change
  h: number;           // high
  l: number;           // low
  o: number;           // open
  pc: number;          // previous close
  t: number;           // last update timestamp (Unix)
  isMarketOpen: boolean;
}

/** Raw Finnhub company profile response */
export interface FinnhubProfile {
  logo: string;  // URL, may be empty string
  name: string;
}

/** Profile data returned by GET /api/stock/profile */
export interface ProfileResponse {
  logo: string;
  name: string;
}

/** Candle data returned by GET /api/stock/candles */
export interface CandlesResponse {
  t: number[]; // Unix timestamps
  c: number[]; // close prices
  s: string;   // "ok" or "no_data"
}

/** A single news article returned by GET /api/stock/news */
export interface NewsArticle {
  id: number;
  datetime: number;
  headline: string;
  source: string;
  summary: string;
  url: string;
  image: string;
}

/** A single ticker entry returned by GET /api/stock/movers */
export interface TickerMover {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
}

/**
 * A single symbol's quote result within a watchlist batch request.
 *
 * Unlike TickerMover, a failed lookup is never dropped from the response — it
 * is returned with status "error" and null numeric fields so the client can
 * still render the row. A watchlist is a deliberately curated list; a silently
 * missing entry reads as data loss to the user.
 */
export interface WatchlistQuoteEntry {
  symbol: string;
  status: "ok" | "error";
  price: number | null;
  change: number | null;
  changePercent: number | null;
  /**
   * Why this row has no price. Present only when status is "error".
   *
   * The distinction is load-bearing for the client, which must treat the two
   * classes differently rather than rendering every failure identically:
   *
   * - "unavailable" — a property of the SYMBOL. Finnhub answered and the
   *   answer was unusable (non-positive price, i.e. an unknown ticker).
   *   Polling again produces the same result. The row is legitimately dataless.
   * - "deferred" — a property of THIS SERVER, RIGHT NOW. The symbol was never
   *   contacted, because the upstream budget was spent or the request deadline
   *   was reached. It says nothing about the symbol, and the next poll may well
   *   succeed. Must never be cached as a symbol-level fact.
   * - "failed" — an upstream call was attempted and errored or timed out.
   *   Transient and retryable.
   *
   * A client must NOT overwrite a previously-good price with a "deferred" or
   * "failed" row — the price it already holds is still the best data it has.
   */
  reason?: "unavailable" | "deferred" | "failed";
}

/** Response body for GET /api/stock/watchlist-quotes */
export interface WatchlistQuotesResponse {
  quotes: WatchlistQuoteEntry[];
  /**
   * True when at least one row is "deferred" — the server ran out of upstream
   * capacity or time and knowingly returned incomplete data.
   *
   * This field exists because a capacity shortage otherwise reaches the client
   * as an ordinary HTTP 200 full of error rows, indistinguishable from success,
   * leaving the user staring at em-dashes with no explanation. A degraded
   * response is a success-shaped failure and has to be surfaced as one.
   */
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// Shared constants used by both the Route Handler and StockChart
// ---------------------------------------------------------------------------

export type ChartRange = "1M" | "3M" | "1Y";

export const RANGE_DAYS: Record<ChartRange, number> = {
  "1M": 30,
  "3M": 90,
  "1Y": 365,
};
