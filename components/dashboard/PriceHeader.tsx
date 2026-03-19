"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatPrice, formatChange, formatPercent } from "@/lib/utils";
import type { QuoteResponse } from "@/lib/finnhub/types";

/** How often (ms) to re-fetch price data while the tab is visible. */
const POLL_INTERVAL_MS = 60_000;

/** Delay (ms) before the automatic retry on 5xx errors. */
const AUTO_RETRY_DELAY_MS = 3_000;

interface Props {
  symbol: string;
  compact?: boolean;
}

export default function PriceHeader({ symbol, compact }: Props) {
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(
    null
  );
  // Tracks the wall-clock time of the most recent successful fetch so we can
  // display a "last updated" label without relying on the API timestamp alone.
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  // Stable ref to the active interval so we can clear it from event listeners
  // without stale closure issues.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasAutoRetriedRef = useRef(false);

  const clearRetryTimers = useCallback(() => {
    if (autoRetryTimerRef.current !== null) {
      clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
    }
    if (countdownTimerRef.current !== null) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  /**
   * Fetches the latest quote for `symbol`.
   * Does NOT reset the quote to null — this prevents the loading skeleton from
   * flickering on every 60-second background poll. The loading skeleton only
   * appears on the very first render (when quote is still null).
   */
  const fetchQuote = useCallback(
    (isAutoRetry = false) => {
      clearRetryTimers();
      setRetryAfterSeconds(null);

      fetch(`/api/stock/quote?symbol=${symbol}`)
        .then((res) => {
          if (res.status === 429) {
            const retryHeader = res.headers.get("Retry-After");
            const seconds =
              retryHeader ? parseInt(retryHeader, 10) : 60;
            const validSeconds =
              Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
            setRetryAfterSeconds(validSeconds);
            setError(
              `Too many requests — retry available in ${validSeconds} seconds`
            );

            countdownTimerRef.current = setInterval(() => {
              setRetryAfterSeconds((prev) => {
                if (prev === null || prev <= 1) {
                  if (countdownTimerRef.current !== null) {
                    clearInterval(countdownTimerRef.current);
                    countdownTimerRef.current = null;
                  }
                  return null;
                }
                return prev - 1;
              });
            }, 1_000);
            return;
          }

          if (res.status >= 500) {
            if (!isAutoRetry && !hasAutoRetriedRef.current) {
              hasAutoRetriedRef.current = true;
              autoRetryTimerRef.current = setTimeout(() => {
                fetchQuote(true);
              }, AUTO_RETRY_DELAY_MS);
              return;
            }
            throw new Error(`Server error (${res.status})`);
          }

          if (!res.ok) throw new Error("Failed to fetch quote");
          return res.json() as Promise<QuoteResponse>;
        })
        .then((data) => {
          if (data !== undefined) {
            setQuote(data);
            setLastUpdatedAt(new Date());
            setError(null);
            setRetryAfterSeconds(null);
          }
        })
        .catch(() => {
          // Only surface the error when no quote has been loaded yet (initial
          // load failure). Subsequent poll failures are silent — the stale
          // "last updated" timestamp communicates freshness implicitly.
          setQuote((currentQuote) => {
            if (currentQuote === null) {
              setError("Unable to load price data. Please try again.");
            }
            return currentQuote;
          });
        });
    },
    [symbol, clearRetryTimers]
  );

  const handleRetry = useCallback(() => {
    hasAutoRetriedRef.current = false;
    clearRetryTimers();
    setRetryAfterSeconds(null);
    setError(null);
    fetchQuote();
  }, [fetchQuote, clearRetryTimers]);

  // ─── Initial fetch + polling ──────────────────────────────────────────────

  useEffect(() => {
    // When the symbol changes, reset state so the loading skeleton reappears.
    setQuote(null);
    setError(null);
    setLastUpdatedAt(null);
    setRetryAfterSeconds(null);
    hasAutoRetriedRef.current = false;

    // Kick off the first fetch immediately.
    fetchQuote();

    function startInterval() {
      // Guard: never stack multiple intervals.
      if (intervalRef.current !== null) return;
      intervalRef.current = setInterval(() => fetchQuote(), POLL_INTERVAL_MS);
    }

    function clearIntervalRef() {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    // Pause polling when the tab goes to the background; resume when it
    // returns to the foreground with an immediate re-fetch so the price is
    // never stale after a long absence.
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        clearIntervalRef();
      } else {
        fetchQuote();
        startInterval();
      }
    }

    if (document.visibilityState === "visible") {
      startInterval();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearIntervalRef();
      clearRetryTimers();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  // ─── Render ───────────────────────────────────────────────────────────────

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
                onClick={handleRetry}
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

  if (!quote) {
    return (
      <div className="flex animate-pulse motion-reduce:animate-none flex-col gap-2">
        <div
          className={`rounded bg-zinc-800 ${
            compact
              ? "h-6 w-24 sm:h-8 sm:w-32 md:h-10 md:w-40"
              : "h-10 w-40"
          }`}
        />
        <div
          className={`rounded bg-zinc-800 ${
            compact ? "h-4 w-20 sm:h-5 sm:w-28 md:w-32" : "h-5 w-32"
          }`}
        />
      </div>
    );
  }

  const isPositive = quote.d >= 0;

  // Format the last-updated time as HH:MM:SS in the user's local timezone.
  const updatedLabel = lastUpdatedAt
    ? lastUpdatedAt.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  return (
    <div className="flex flex-col gap-1">
      {/* Price row */}
      <div
        className={`flex flex-wrap items-baseline ${
          compact ? "gap-1.5 sm:gap-2 md:gap-3" : "gap-3"
        }`}
      >
        <span
          className={`font-semibold tracking-tight text-zinc-100 ${
            compact ? "text-xl sm:text-2xl md:text-4xl" : "text-4xl"
          }`}
        >
          {formatPrice(quote.c)}
        </span>
        <span
          className={`font-medium ${
            compact ? "text-xs sm:text-sm md:text-lg" : "text-lg"
          } ${isPositive ? "text-green-400" : "text-red-400"}`}
        >
          {formatChange(quote.d)} {formatPercent(quote.dp)}
        </span>
        {!quote.isMarketOpen && (
          <span
            className={`rounded bg-zinc-800 font-medium text-zinc-400 ${
              compact
                ? "px-1.5 py-0.5 text-[10px] sm:text-xs md:px-2"
                : "px-2 py-0.5 text-xs"
            }`}
          >
            Market closed
          </span>
        )}
      </div>

      {/* Last updated indicator */}
      {updatedLabel && (
        <div
          className={`flex items-center gap-1.5 ${
            compact ? "text-[9px] sm:text-[10px]" : "text-[10px]"
          } text-zinc-600`}
          aria-live="polite"
          aria-atomic="true"
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-600 motion-safe:animate-pulse"
            aria-hidden="true"
          />
          <span>Updated {updatedLabel}</span>
        </div>
      )}
    </div>
  );
}
