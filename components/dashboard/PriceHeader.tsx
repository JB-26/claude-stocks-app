"use client";

import { useState, useEffect } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatPrice, formatChange, formatPercent } from "@/lib/utils";
import type { QuoteResponse } from "@/lib/finnhub/types";

interface Props {
  symbol: string;
}

export default function PriceHeader({ symbol }: Props) {
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQuote(null);
    setError(null);

    fetch(`/api/stock/quote?symbol=${symbol}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch quote");
        return res.json() as Promise<QuoteResponse>;
      })
      .then(setQuote)
      .catch(() => setError("Unable to load price data. Please try again."));
  }, [symbol]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!quote) {
    return (
      <div className="flex animate-pulse motion-reduce:animate-none flex-col gap-2">
        <div className="h-10 w-40 rounded bg-zinc-800" />
        <div className="h-5 w-32 rounded bg-zinc-800" />
      </div>
    );
  }

  const isPositive = quote.d >= 0;

  return (
    <div className="flex flex-wrap items-baseline gap-3">
      <span className="text-4xl font-semibold tracking-tight text-zinc-100">
        {formatPrice(quote.c)}
      </span>
      <span
        className={`text-lg font-medium ${
          isPositive ? "text-green-400" : "text-red-400"
        }`}
      >
        {formatChange(quote.d)} {formatPercent(quote.dp)}
      </span>
      {!quote.isMarketOpen && (
        <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-400">
          Market closed
        </span>
      )}
    </div>
  );
}
