import "server-only";

import type { CandlesResponse, ChartRange } from "./finnhub/types";

const RANGE_MAP: Record<ChartRange, string> = {
  "1M": "1mo",
  "3M": "3mo",
  "1Y": "1y",
};

export async function getHistoricalCandles(
  symbol: string,
  range: ChartRange
): Promise<CandlesResponse> {
  const yahooRange = RANGE_MAP[range];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${yahooRange}`;

  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; claude-stocks-app/1.0)" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Yahoo Finance request failed: ${response.status} ${response.statusText}`
    );
  }

  const json = await response.json();
  const result = json?.chart?.result?.[0];

  if (!result) {
    return { t: [], c: [], s: "no_data" };
  }

  const timestamps: number[] = result.timestamp ?? [];
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];

  // Filter out null entries that Yahoo Finance inserts for non-trading days
  const filtered = timestamps.reduce<{ t: number[]; c: number[] }>(
    (acc, ts, i) => {
      if (closes[i] != null) {
        acc.t.push(ts);
        acc.c.push(closes[i] as number);
      }
      return acc;
    },
    { t: [], c: [] }
  );

  return { t: filtered.t, c: filtered.c, s: "ok" };
}
