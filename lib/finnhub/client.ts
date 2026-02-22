import "server-only";

import type {
  FinnhubCandles,
  FinnhubNewsArticle,
  FinnhubQuote,
  FinnhubSearchResponse,
} from "./types";

const BASE_URL = "https://finnhub.io/api/v1";

function getApiKey(): string {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    throw new Error("FINNHUB_API_KEY environment variable is not set");
  }
  return key;
}

async function finnhubFetch<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    headers: { "X-Finnhub-Token": getApiKey() },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Finnhub request failed: ${response.status} ${response.statusText} (${url})`
    );
  }

  return response.json() as Promise<T>;
}

export async function searchSymbols(
  query: string
): Promise<FinnhubSearchResponse> {
  return finnhubFetch<FinnhubSearchResponse>(
    `/search?q=${encodeURIComponent(query)}`
  );
}

export async function getQuote(symbol: string): Promise<FinnhubQuote> {
  return finnhubFetch<FinnhubQuote>(`/quote?symbol=${encodeURIComponent(symbol)}`);
}

export async function getCandles(
  symbol: string,
  from: number,
  to: number
): Promise<FinnhubCandles> {
  return finnhubFetch<FinnhubCandles>(
    `/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}`
  );
}

export async function getCompanyNews(
  symbol: string,
  from: string,
  to: string
): Promise<FinnhubNewsArticle[]> {
  return finnhubFetch<FinnhubNewsArticle[]>(
    `/company-news?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  );
}
