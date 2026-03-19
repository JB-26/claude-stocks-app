"use client";

import { useState, useEffect } from "react";
import CompanyLogo from "@/components/dashboard/CompanyLogo";
import PriceHeader from "@/components/dashboard/PriceHeader";
import KeyMetrics from "@/components/dashboard/KeyMetrics";
import ChartWrapper from "@/components/dashboard/ChartWrapper";
import NewsFeed from "@/components/dashboard/NewsFeed";
import WatchlistButton from "@/components/dashboard/WatchlistButton";
import type { ProfileResponse } from "@/lib/finnhub/types";

interface Props {
  symbol: string;
  compact?: boolean;
  showNews?: boolean;
}

/**
 * CompanyPanel is the top-level panel for a single stock.
 *
 * Profile data (logo + name) is fetched here rather than duplicating the
 * fetch in CompanyLogo, because CompanyPanel needs `name` for the heading.
 * Both CompanyLogo and this component hit the same server-side cached
 * endpoint (`profile:<symbol>`, 1-hour TTL), so the second in-flight request
 * always returns the cached value — no extra Finnhub API call is made.
 */
export default function CompanyPanel({ symbol, compact, showNews = true }: Props) {
  const [companyName, setCompanyName] = useState<string | null>(null);

  useEffect(() => {
    setCompanyName(null);

    fetch(`/api/stock/profile?symbol=${symbol}`)
      .then((res) => {
        if (!res.ok) return;
        return res.json() as Promise<ProfileResponse>;
      })
      .then((data) => {
        if (data?.name) setCompanyName(data.name);
      })
      .catch(() => {});
  }, [symbol]);

  return (
    <section
      aria-label={companyName ?? symbol}
      data-testid={`company-panel-${symbol}`}
      className={`min-w-0 ${compact ? "px-3 py-4 sm:px-4 sm:py-6 md:px-6 md:py-8" : "px-6 py-8"}`}
    >
      {/* ── Company header: logo + ticker + name + live price ── */}
      <div
        className={`flex items-center border-b border-zinc-800 ${
          compact
            ? "mb-4 gap-3 pb-4 sm:mb-6 sm:gap-4 sm:pb-6 md:mb-8 md:gap-5 md:pb-8"
            : "mb-8 gap-5 pb-8"
        }`}
      >
        <CompanyLogo symbol={symbol} compact={compact} />

        <div className="min-w-0">
          {/* Ticker symbol — always shown, acts as the label while name loads */}
          <p
            className={`font-medium uppercase tracking-widest text-zinc-500 ${
              compact
                ? "mb-0.5 text-[10px] sm:text-xs md:text-sm"
                : "text-sm"
            }`}
          >
            {symbol}
          </p>

          {/*
            Company full name — rendered once the profile response arrives.
            Using <p> rather than a heading element: in split and multi views
            multiple panels appear on the same page simultaneously, so a fixed
            heading level would either create duplicate h1s or skip levels.
            The name is styled to read prominently without abusing heading
            semantics. The `title` attribute exposes the full name on hover
            when it overflows with ellipsis in compact mode.
          */}
          {companyName && (
            <p
              className={`truncate font-semibold text-zinc-100 ${
                compact
                  ? "mb-1.5 text-sm sm:mb-2 sm:text-base md:text-lg"
                  : "mb-2 text-lg"
              }`}
              title={companyName}
            >
              {companyName}
            </p>
          )}

          <PriceHeader symbol={symbol} compact={compact} />
        </div>

        {!compact && (
          <div className="ml-auto self-start">
            <WatchlistButton symbol={symbol} />
          </div>
        )}
      </div>

      {/* ── Key metrics row (open / high / low / prev close) ── */}
      <div
        className={
          compact
            ? "mb-4 sm:mb-6 md:mb-8"
            : "mb-8"
        }
      >
        <KeyMetrics symbol={symbol} compact={compact} />
      </div>

      {/* ── Historical price chart ── */}
      <div className={compact ? "mb-6 sm:mb-8 md:mb-10" : "mb-10"}>
        <ChartWrapper symbol={symbol} compact={compact} />
      </div>

      {showNews && <NewsFeed symbol={symbol} />}
    </section>
  );
}
