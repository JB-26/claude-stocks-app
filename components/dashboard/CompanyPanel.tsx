"use client";

import CompanyLogo from "@/components/dashboard/CompanyLogo";
import PriceHeader from "@/components/dashboard/PriceHeader";
import ChartWrapper from "@/components/dashboard/ChartWrapper";
import NewsFeed from "@/components/dashboard/NewsFeed";

interface Props {
  symbol: string;
  compact?: boolean;
  showNews?: boolean;
}

export default function CompanyPanel({ symbol, compact, showNews = true }: Props) {
  return (
    <section
      aria-label={symbol}
      data-testid={`company-panel-${symbol}`}
      className={`min-w-0 ${compact ? "px-3 py-4 sm:px-4 sm:py-6 md:px-6 md:py-8" : "px-6 py-8"}`}
    >
      <div className={`flex items-center border-b border-zinc-800 ${compact ? "mb-4 gap-3 pb-4 sm:mb-6 sm:gap-4 sm:pb-6 md:mb-8 md:gap-5 md:pb-8" : "mb-8 gap-5 pb-8"}`}>
        <CompanyLogo symbol={symbol} compact={compact} />
        <div className="min-w-0">
          <p className={`font-medium uppercase tracking-widest text-zinc-500 ${compact ? "mb-1 text-[10px] sm:mb-1.5 sm:text-xs md:mb-2 md:text-sm" : "mb-2 text-sm"}`}>
            {symbol}
          </p>
          <PriceHeader symbol={symbol} compact={compact} />
        </div>
      </div>

      <div className={compact ? "mb-6 sm:mb-8 md:mb-10" : "mb-10"}>
        <ChartWrapper symbol={symbol} compact={compact} />
      </div>

      {showNews && <NewsFeed symbol={symbol} />}
    </section>
  );
}
