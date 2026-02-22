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

// ---------------------------------------------------------------------------
// Shared constants used by both the Route Handler and StockChart
// ---------------------------------------------------------------------------

export type ChartRange = "1M" | "3M" | "1Y";

export const RANGE_DAYS: Record<ChartRange, number> = {
  "1M": 30,
  "3M": 90,
  "1Y": 365,
};
