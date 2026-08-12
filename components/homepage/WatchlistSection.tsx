"use client";

import { useWatchlistSymbols } from "@/hooks/useWatchlistSymbols";
import RecentlyViewedChips from "@/components/search/RecentlyViewedChips";
import WatchlistPanel from "@/components/homepage/WatchlistPanel";

/**
 * WatchlistSection — owns the panel-vs-chips gating decision so app/page.tsx
 * can stay a Server Component.
 *
 * localStorage is SSR-blind, so which of WatchlistPanel or RecentlyViewedChips
 * applies (never both) can't be known until after the mount effect runs. This
 * renders `null` until then, matching server and first-client-render markup
 * — no hydration *mismatch*, since both sides render nothing regardless of
 * what's actually in localStorage.
 *
 * A previous version of this component reserved a fixed-height placeholder
 * (matching RecentlyViewedChips' single-row height) instead of `null`, to
 * soften the reflow when chips appear post-hydration. That trade was net
 * negative: it created a *new* shift for the most common visitor — someone
 * with neither a watchlist nor any recently-viewed symbols — who previously
 * saw zero layout movement (RecentlyViewedChips has always rendered `null`
 * for that case, both before and after hydration) and would now see a
 * reserved block appear then immediately collapse away. Optimizing the
 * minority case (chips) at the expense of the majority case (nothing) is the
 * wrong trade, so this goes back to `null` for everyone. The chips/panel
 * cases still reflow when their content lands post-hydration — unavoidable
 * without knowing localStorage contents before the client mounts — but that
 * reflow is no worse than it was before any gating placeholder existed.
 */
export default function WatchlistSection() {
  const { symbols, hydrated, remove } = useWatchlistSymbols();

  if (!hydrated) {
    return null;
  }

  return symbols.length > 0 ? (
    <WatchlistPanel symbols={symbols} onRemove={remove} />
  ) : (
    <RecentlyViewedChips />
  );
}
