"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useDebounce } from "@/hooks/useDebounce";
import SearchResults from "./SearchResults";
import type { SearchResult } from "@/lib/finnhub/types";

export default function SearchBar() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debouncedQuery = useDebounce(query, 350);

  // Fetch results whenever the debounced query changes
  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < 1) {
      setResults([]);
      setIsOpen(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setIsOpen(true);

    fetch(`/api/stock/search?q=${encodeURIComponent(trimmed)}`)
      .then((res) => res.json())
      .then((data: { results: SearchResult[] }) => {
        if (!cancelled) {
          setResults(data.results ?? []);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResults([]);
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleSelect(symbol: string) {
    setIsOpen(false);
    setQuery("");
    router.push(`/dashboard?symbol=${symbol}`);
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="flex w-full gap-3">
        <input
          role="searchbox"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (results.length > 0) setIsOpen(true);
          }}
          placeholder="Search for a company or ticker symbol..."
          className="h-12 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
          autoComplete="off"
        />
        <button
          type="button"
          className="h-12 rounded-lg bg-green-700 px-6 text-sm font-medium text-white transition-colors hover:bg-green-600 disabled:opacity-50"
          disabled={query.trim().length === 0}
          onClick={() => {
            if (results.length > 0) handleSelect(results[0].symbol);
          }}
        >
          Search
        </button>
      </div>

      {isOpen && (
        <SearchResults
          results={results}
          isLoading={isLoading}
          onSelect={handleSelect}
        />
      )}
    </div>
  );
}
