"use client";

import { useState, useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatPrice } from "@/lib/utils";
import type { QuoteResponse } from "@/lib/finnhub/types";

interface Props {
  symbol: string;
  compact?: boolean;
}

interface MetricItemProps {
  label: string;
  value: string;
  compact?: boolean;
}

/**
 * A single labelled metric cell.
 * Uses <dt>/<dd> semantics — must be rendered inside a <dl>.
 */
function MetricItem({ label, value, compact }: MetricItemProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt
        className={`font-medium uppercase tracking-widest text-zinc-500 ${
          compact ? "text-[9px] sm:text-[10px]" : "text-[10px]"
        }`}
      >
        {label}
      </dt>
      <dd
        className={`font-semibold tabular-nums text-zinc-200 ${
          compact ? "text-xs sm:text-sm" : "text-sm"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

/** Placeholder shown while the quote response is in flight. */
function KeyMetricsSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading key metrics"
      className="flex flex-wrap gap-x-6 gap-y-3"
    >
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton
          key={i}
          className={`motion-reduce:animate-none ${
            compact ? "h-8 w-16 sm:w-20" : "h-8 w-20"
          }`}
        />
      ))}
    </div>
  );
}

/**
 * KeyMetrics surfaces the four secondary price data points from the quote
 * endpoint: open, day high, day low, and previous close.
 *
 * The quote endpoint is already cached server-side (60s TTL), so this fetch
 * never triggers a second Finnhub API call — it returns the in-memory cached
 * response. PriceHeader owns the polling; KeyMetrics fetches once per symbol
 * and is intentionally static (these values change rarely intraday).
 */
export default function KeyMetrics({ symbol, compact }: Props) {
  const [quote, setQuote] = useState<QuoteResponse | null>(null);

  useEffect(() => {
    setQuote(null);

    fetch(`/api/stock/quote?symbol=${symbol}`)
      .then((res) => {
        if (!res.ok) throw new Error("quote fetch failed");
        return res.json() as Promise<QuoteResponse>;
      })
      .then(setQuote)
      // Silently suppress errors — PriceHeader already shows an error alert
      // when the quote endpoint fails, so KeyMetrics simply stays hidden.
      .catch(() => {});
  }, [symbol]);

  if (!quote) {
    return <KeyMetricsSkeleton compact={compact} />;
  }

  const metrics = [
    { label: "Open", value: formatPrice(quote.o) },
    { label: "High", value: formatPrice(quote.h) },
    { label: "Low", value: formatPrice(quote.l) },
    { label: "Prev Close", value: formatPrice(quote.pc) },
  ] as const;

  return (
    <dl
      className={`flex flex-wrap ${
        compact ? "gap-x-4 gap-y-2 sm:gap-x-6 sm:gap-y-3" : "gap-x-6 gap-y-3"
      }`}
      aria-label="Key price metrics"
    >
      {metrics.map(({ label, value }) => (
        <MetricItem key={label} label={label} value={value} compact={compact} />
      ))}
    </dl>
  );
}
