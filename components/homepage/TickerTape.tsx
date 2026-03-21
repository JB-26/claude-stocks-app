"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { TickerMover } from "@/lib/finnhub/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPrice(price: number): string {
  return price.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatChangePercent(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface TickerItemProps {
  mover: TickerMover;
}

function TickerItem({ mover }: TickerItemProps) {
  const isPositive = mover.changePercent >= 0;
  const changeColor = isPositive ? "text-green-400" : "text-red-400";

  return (
    <Link
      href={`/dashboard?symbol=${mover.symbol}`}
      className="flex shrink-0 items-center gap-3 px-6 transition-opacity hover:opacity-70"
    >
      <span className="font-mono text-xs font-semibold tracking-wider text-zinc-200">
        {mover.symbol}
      </span>
      <span className="font-mono text-xs text-zinc-400">
        ${formatPrice(mover.price)}
      </span>
      <span className={`font-mono text-xs font-medium ${changeColor}`}>
        {formatChangePercent(mover.changePercent)}
      </span>
    </Link>
  );
}

/** Vertical rule separator between ticker items */
function TickerDivider() {
  return (
    <span
      aria-hidden="true"
      className="h-3 w-px shrink-0 bg-zinc-700"
    />
  );
}

// ---------------------------------------------------------------------------
// Skeleton shown while data loads
// ---------------------------------------------------------------------------

function TickerSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex h-9 w-full items-center border-b border-zinc-800 bg-zinc-950/60 px-6"
    >
      <div className="h-2 w-48 animate-pulse rounded bg-zinc-800" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * TickerTape renders a horizontally scrolling strip of major US stock quotes
 * at the top of the homepage.
 *
 * Accessibility notes:
 * - The animated track is aria-hidden; the static fallback list provides the
 *   accessible representation for screen readers and reduced-motion users.
 * - The duplicate track (for seamless looping) is aria-hidden="true".
 */
export default function TickerTape() {
  const [movers, setMovers] = useState<TickerMover[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;

    async function fetchMovers() {
      try {
        const res = await fetch("/api/stock/movers");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as TickerMover[];
        if (!cancelled) {
          setMovers(data);
          setStatus("ready");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    void fetchMovers();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "loading") return <TickerSkeleton />;

  // On error, render nothing — the homepage is still fully usable without the tape.
  if (status === "error" || movers.length === 0) return null;

  // Build an interleaved array: item, divider, item, divider, …
  function buildTrack(items: TickerMover[], ariaHidden: boolean) {
    return (
      <div
        className="flex items-center"
        aria-hidden={ariaHidden || undefined}
      >
        {items.map((mover, i) => (
          <span key={`${mover.symbol}-${i}`} className="flex items-center">
            <TickerItem mover={mover} />
            <TickerDivider />
          </span>
        ))}
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Live market ticker"
      className="w-full overflow-hidden border-b border-zinc-800 bg-zinc-950/60"
    >
      {/*
        Animated marquee track.
        aria-hidden because the static list below serves as the accessible
        representation. The .ticker-track CSS class carries the animation;
        prefers-reduced-motion disables it in globals.css.
      */}
      <div className="ticker-track flex" aria-hidden="true">
        {buildTrack(movers, true)}
        {/* Duplicate set for seamless infinite loop */}
        {buildTrack(movers, true)}
      </div>

      {/*
        Screen-reader and reduced-motion fallback: a static, visually hidden
        list of all tickers. Visible when reduced motion is preferred via the
        `motion-reduce:block` Tailwind variant — but we handle this via CSS
        animation removal in globals.css, so this list stays visually hidden
        in all cases and is purely for AT.
      */}
      <nav
        aria-label="Market tickers"
        className="sr-only"
      >
        <ul>
          {movers.map((mover) => (
            <li key={mover.symbol}>
              <Link href={`/dashboard?symbol=${mover.symbol}`}>
                {mover.symbol} — ${formatPrice(mover.price)}{" "}
                {formatChangePercent(mover.changePercent)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
