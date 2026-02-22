"use client";

import { useState } from "react";

export default function SearchBar() {
  const [query, setQuery] = useState("");

  return (
    <div className="flex w-full gap-3">
      <input
        role="searchbox"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for a company or ticker symbol..."
        className="h-12 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
      />
      <button
        type="button"
        className="h-12 rounded-lg bg-green-700 px-6 text-sm font-medium text-white transition-colors hover:bg-green-600 disabled:opacity-50"
        disabled={query.trim().length === 0}
      >
        Search
      </button>
    </div>
  );
}
