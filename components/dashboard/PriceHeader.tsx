"use client";

import { useState, useEffect } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatPrice, formatChange, formatPercent } from "@/lib/utils";
import type { QuoteResponse } from "@/lib/finnhub/types";

interface Props {
  symbol: string;
  compact?: boolean;
}

export default function PriceHeader({ symbol, compact }: Props) {
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
        <div className={`rounded bg-zinc-800 ${compact ? "h-6 w-24 sm:h-8 sm:w-32 md:h-10 md:w-40" : "h-10 w-40"}`} />
        <div className={`rounded bg-zinc-800 ${compact ? "h-4 w-20 sm:h-5 sm:w-28 md:w-32" : "h-5 w-32"}`} />
      </div>
    );
  }

  const isPositive = quote.d >= 0;

  return (
    <div className={`flex flex-wrap items-baseline ${compact ? "gap-1.5 sm:gap-2 md:gap-3" : "gap-3"}`}>
      <span className={`font-semibold tracking-tight text-zinc-100 ${compact ? "text-xl sm:text-2xl md:text-4xl" : "text-4xl"}`}>
        {formatPrice(quote.c)}
      </span>
      <span
        className={`font-medium ${compact ? "text-xs sm:text-sm md:text-lg" : "text-lg"} ${
          isPositive ? "text-green-400" : "text-red-400"
        }`}
      >
        {formatChange(quote.d)} {formatPercent(quote.dp)}
      </span>
      {!quote.isMarketOpen && (
        <span className={`rounded bg-zinc-800 font-medium text-zinc-400 ${compact ? "px-1.5 py-0.5 text-[10px] sm:text-xs md:px-2" : "px-2 py-0.5 text-xs"}`}>
          Market closed
        </span>
      )}
    </div>
  );
}
