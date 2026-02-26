"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { loadRecent } from "@/lib/session";
import type { ViewMode } from "@/lib/view";

interface Props {
  currentSymbol: string;
}

function buildViewUrl(
  pathname: string,
  current: URLSearchParams,
  mode: ViewMode,
  recentSymbols: string[]
): string {
  const params = new URLSearchParams();
  params.set("symbol", current.get("symbol") ?? "");

  if (mode === "split") {
    params.set("view", "split");
    if (recentSymbols[1]) params.set("symbol2", recentSymbols[1]);
  } else if (mode === "multi") {
    params.set("view", "multi");
    if (recentSymbols[1]) params.set("symbol2", recentSymbols[1]);
    if (recentSymbols[2]) params.set("symbol3", recentSymbols[2]);
  }
  // "default" mode: only symbol param, no view/symbol2/symbol3

  return `${pathname}?${params.toString()}`;
}

const VIEW_OPTIONS: { mode: ViewMode; label: string }[] = [
  { mode: "default", label: "Default View" },
  { mode: "split", label: "Split View" },
  { mode: "multi", label: "Multi View" },
];

export default function ViewSelector({ currentSymbol: _currentSymbol }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [announcement, setAnnouncement] = useState("");

  const currentView: ViewMode =
    searchParams.get("view") === "split"
      ? "split"
      : searchParams.get("view") === "multi"
        ? "multi"
        : "default";

  function handleSelect(mode: ViewMode) {
    if (mode === currentView) return;

    const recentSymbols = loadRecent();
    const url = buildViewUrl(pathname, searchParams, mode, recentSymbols);
    setAnnouncement(`Switched to ${mode} view`);
    router.push(url);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Select dashboard view mode"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-800"
          >
            View
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="border-zinc-700 bg-zinc-900 text-zinc-100"
        >
          {VIEW_OPTIONS.map(({ mode, label }) => (
            <DropdownMenuCheckboxItem
              key={mode}
              checked={currentView === mode}
              onSelect={() => handleSelect(mode)}
              className="cursor-pointer"
            >
              {label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </>
  );
}
