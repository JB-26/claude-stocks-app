"use client";

import { Skeleton } from "@/components/ui/skeleton";
import type { SearchResult } from "@/lib/finnhub/types";

interface Props {
  results: SearchResult[];
  isLoading: boolean;
  onSelect: (symbol: string) => void;
}

export default function SearchResults({ results, isLoading, onSelect }: Props) {
  if (!isLoading && results.length === 0) return null;

  return (
    <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
      {isLoading ? (
        <div className="flex flex-col gap-2 p-3">
          <Skeleton className="h-9 w-full bg-zinc-800" />
          <Skeleton className="h-9 w-full bg-zinc-800" />
          <Skeleton className="h-9 w-4/5 bg-zinc-800" />
        </div>
      ) : (
        <ul>
          {results.map((result) => (
            <li key={result.symbol}>
              <button
                type="button"
                onClick={() => onSelect(result.symbol)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-zinc-800"
              >
                <span className="w-16 shrink-0 font-mono text-xs font-semibold text-zinc-100">
                  {result.displaySymbol}
                </span>
                <span className="truncate text-sm text-zinc-400">
                  {result.description}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
