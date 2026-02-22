import { NextResponse } from "next/server";
import { getCompanyNews } from "@/lib/finnhub/client";
import { getCached, setCached } from "@/lib/cache";
import type { NewsArticle } from "@/lib/finnhub/types";

const NEWS_TTL_MS = 5 * 60_000; // 5 minutes
const SYMBOL_RE = /^[A-Z]{1,10}$/;
const MAX_ARTICLES = 10;

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol") ?? "";

  if (!SYMBOL_RE.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  const cacheKey = `news:${symbol}`;
  const cached = getCached<{ articles: NewsArticle[] }>(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);

  try {
    const raw = await getCompanyNews(
      symbol,
      toDateString(from),
      toDateString(to)
    );

    const articles: NewsArticle[] = raw.slice(0, MAX_ARTICLES).map((a) => ({
      id: a.id,
      datetime: a.datetime,
      headline: a.headline,
      source: a.source,
      summary: a.summary,
      url: a.url,
      image: a.image,
    }));

    const response = { articles };
    setCached(cacheKey, response, NEWS_TTL_MS);
    return NextResponse.json(response);
  } catch (err) {
    console.error("[/api/stock/news]", err);
    return NextResponse.json(
      { error: "Failed to fetch news" },
      { status: 500 }
    );
  }
}
