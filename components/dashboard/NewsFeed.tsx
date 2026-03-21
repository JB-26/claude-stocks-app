"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { useRetryableFetch } from "@/hooks/useRetryableFetch";
import type { NewsArticle } from "@/lib/finnhub/types";

interface Props {
  symbol: string;
}

export default function NewsFeed({ symbol }: Props) {
  const url = `/api/stock/news?symbol=${symbol}`;
  const {
    data,
    error,
    isLoading,
    retryAfterSeconds,
    retry,
  } = useRetryableFetch<{ articles: NewsArticle[] }>(url, {
    label: "news",
  });

  const articles = data?.articles ?? null;

  if (error) {
    const isRateLimited = retryAfterSeconds !== null && retryAfterSeconds > 0;
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <div className="flex items-center justify-between gap-2">
            <span>
              {isRateLimited
                ? `Too many requests — retrying in ${retryAfterSeconds} seconds`
                : error}
            </span>
            {!isRateLimited && (
              <button
                type="button"
                onClick={retry}
                className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-zinc-100 transition-colors hover:bg-zinc-700"
              >
                Retry
              </button>
            )}
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-medium uppercase tracking-widest text-zinc-500">
        Latest News
      </h2>

      {isLoading || !articles ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse motion-reduce:animate-none rounded-lg bg-zinc-800"
            />
          ))}
        </div>
      ) : articles.length === 0 ? (
        <p className="text-sm text-zinc-500">No recent news available.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {articles.map((article) => (
            <a
              key={article.id}
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block transition-opacity hover:opacity-80"
            >
              <Card className="border-zinc-800 bg-zinc-900">
                <CardContent className="px-4 py-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-zinc-500">
                      {article.source}
                    </span>
                    <span className="shrink-0 text-xs text-zinc-600">
                      {new Date(article.datetime * 1000).toLocaleDateString(
                        "en-US",
                        { month: "short", day: "numeric" }
                      )}
                    </span>
                  </div>
                  <p className="text-sm font-medium leading-snug text-zinc-100">
                    {article.headline}
                  </p>
                  {article.summary && (
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-400">
                      {article.summary}
                    </p>
                  )}
                </CardContent>
              </Card>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
