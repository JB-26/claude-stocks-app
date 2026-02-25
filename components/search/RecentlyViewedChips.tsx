"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { loadRecent } from "@/lib/session";

export default function RecentlyViewedChips() {
  const [symbols, setSymbols] = useState<string[]>([]);

  useEffect(() => {
    const recent = loadRecent();
    setSymbols(recent);
  }, []);

  // Render nothing if no recent symbols — avoids CLS
  if (symbols.length === 0) {
    return null;
  }

  return (
    <nav aria-label="Recently viewed stocks" className="flex flex-wrap justify-center gap-2">
      {symbols.map((symbol) => (
        <Link
          key={symbol}
          href={`/dashboard?symbol=${symbol}`}
          className="rounded-full border border-zinc-700 px-4 py-2 text-xs font-mono text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
        >
          {symbol}
        </Link>
      ))}
    </nav>
  );
}
