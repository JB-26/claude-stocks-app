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
    <section aria-label={symbol} data-testid={`company-panel-${symbol}`} className="min-w-0 px-6 py-8">
      <div className="mb-8 flex items-center gap-5 border-b border-zinc-800 pb-8">
        <CompanyLogo symbol={symbol} />
        <div>
          <p className="mb-2 text-sm font-medium uppercase tracking-widest text-zinc-500">
            {symbol}
          </p>
          <PriceHeader symbol={symbol} />
        </div>
      </div>

      <div className="mb-10">
        <ChartWrapper symbol={symbol} compact={compact} />
      </div>

      {showNews && <NewsFeed symbol={symbol} />}
    </section>
  );
}
