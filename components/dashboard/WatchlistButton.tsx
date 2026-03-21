"use client";

import { useState, useEffect, useCallback } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { isInWatchlist, addToWatchlist, removeFromWatchlist } from "@/lib/watchlist";

interface Props {
  symbol: string;
}

/**
 * WatchlistButton — save/unsave a stock symbol to the persistent watchlist.
 *
 * Renders a bookmark icon button. When the symbol is saved the icon is filled
 * (BookmarkCheck, green). When unsaved it renders the outline variant in zinc.
 *
 * localStorage is read on mount (client-only) so the initial render is always
 * the unsaved state — this avoids a hydration mismatch.
 */
export default function WatchlistButton({ symbol }: Props) {
  const [saved, setSaved] = useState(false);

  // Read the persisted state after hydration — localStorage is unavailable
  // during SSR so we always start with false and correct on mount.
  useEffect(() => {
    setSaved(isInWatchlist(symbol));
  }, [symbol]);

  const handleToggle = useCallback(() => {
    if (saved) {
      removeFromWatchlist(symbol);
      setSaved(false);
    } else {
      addToWatchlist(symbol);
      setSaved(true);
    }
  }, [saved, symbol]);

  return (
    <button
      type="button"
      onClick={handleToggle}
      aria-label={saved ? `Remove ${symbol} from watchlist` : `Add ${symbol} to watchlist`}
      aria-pressed={saved}
      title={saved ? "Remove from watchlist" : "Add to watchlist"}
      className={[
        "flex h-8 w-8 items-center justify-center rounded-md",
        "transition-colors focus-visible:outline-none focus-visible:ring-2",
        "focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950",
        saved
          ? "text-green-400 hover:text-green-300"
          : "text-zinc-500 hover:text-zinc-300",
      ].join(" ")}
    >
      {saved ? (
        <BookmarkCheck className="h-5 w-5" aria-hidden="true" />
      ) : (
        <Bookmark className="h-5 w-5" aria-hidden="true" />
      )}
    </button>
  );
}
