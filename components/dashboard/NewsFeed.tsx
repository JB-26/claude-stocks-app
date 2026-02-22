"use client";

import { useState, useEffect } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import type { NewsArticle } from "@/lib/finnhub/types";

interface Props {
  symbol: string;
}

export default function NewsFeed({ symbol }: Props) {
  const [articles, setArticles] = useState<NewsArticle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setArticles(null);
    setError(null);

    fetch(`/api/stock/news?symbol=${symbol}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch news");
        return res.json() as Promise<{ articles: NewsArticle[] }>;
      })
      .then((data) => setArticles(data.articles))
      .catch(() => setError("Unable to load news. Please try again."));
  }, [symbol]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-medium uppercase tracking-widest text-zinc-500">
        Latest News
      </h2>

      {!articles ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-lg bg-zinc-800"
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
