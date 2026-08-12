"use client";

import { useState, useEffect, useCallback } from "react";
import { getWatchlist, removeFromWatchlist, WATCHLIST_KEY } from "@/lib/watchlist";

export interface UseWatchlistSymbolsResult {
  /** [] until hydrated, then the persisted watchlist symbols. */
  symbols: string[];
  /** false on server + first client render, true after the mount effect runs. */
  hydrated: boolean;
  /** Removes a symbol from the persisted watchlist and updates local state. */
  remove: (symbol: string) => void;
}

/**
 * Single source of truth for "what does the homepage currently know about
 * the watchlist" — shared by WatchlistSection's panel-vs-chips gating
 * decision and passed down to WatchlistPanel for rendering.
 *
 * localStorage is unavailable during SSR, so this always starts empty and
 * corrects on mount — the same hydration idiom already used by
 * WatchlistButton (`useEffect(() => setSaved(isInWatchlist(symbol)), ...)`).
 */
export function useWatchlistSymbols(): UseWatchlistSymbolsResult {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setSymbols(getWatchlist());
    setHydrated(true);

    // Reconcile the list when a symbol is added/removed elsewhere, so it's
    // picked up without a full homepage reload. This listener lives here —
    // not in WatchlistPanel — because symbol membership is owned by this
    // hook; WatchlistPanel only owns fetched quote data and derives its
    // rows from whatever `symbols` it's given.
    //
    // Two separate browser events are needed to cover the two ways
    // "elsewhere" can happen, and neither alone is sufficient:
    //
    // - `visibilitychange` covers switching back to this tab after editing
    //   the watchlist in a *different tab* of the same window (e.g. via the
    //   dashboard's WatchlistButton, then Cmd+Tab-ing back).
    // - `storage` covers two side-by-side *windows* (not tabs) — e.g. the
    //   homepage in one window and the dashboard in another. In that case
    //   the homepage window's `document.visibilityState` stays "visible"
    //   the entire time (it's visible in its own window regardless of
    //   whether that window has OS focus), so `visibilitychange` never
    //   fires and this hook would otherwise never reconcile until reload.
    //   `storage` fires in every *other* same-origin tab/window whenever
    //   localStorage is written, which is exactly the case
    //   `visibilitychange` misses.
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        setSymbols(getWatchlist());
      }
    }

    function handleStorageChange(event: StorageEvent) {
      // event.key is null for a wholesale clear(); otherwise only react to
      // writes on the watchlist's own key.
      if (event.key === null || event.key === WATCHLIST_KEY) {
        setSymbols(getWatchlist());
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    addEventListener("storage", handleStorageChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      removeEventListener("storage", handleStorageChange);
    };
  }, []);

  const remove = useCallback((symbol: string) => {
    // removeFromWatchlist already returns the updated list — no need to
    // re-derive it with a second getWatchlist() call.
    setSymbols(removeFromWatchlist(symbol));
  }, []);

  return { symbols, hydrated, remove };
}
