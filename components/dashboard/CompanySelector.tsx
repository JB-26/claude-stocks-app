"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STORAGE_KEY = "recentSymbols";
const MAX_RECENT = 8;

function loadRecent(): string[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveRecent(symbols: string[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(symbols));
  } catch {
    // sessionStorage unavailable — silently ignore
  }
}

function mergeSymbol(current: string, existing: string[]): string[] {
  const deduped = [current, ...existing.filter((s) => s !== current)];
  return deduped.slice(0, MAX_RECENT);
}

interface Props {
  currentSymbol: string;
}

export default function CompanySelector({ currentSymbol }: Props) {
  const router = useRouter();
  const [recentSymbols, setRecentSymbols] = useState<string[]>([currentSymbol]);

  // On mount: read sessionStorage and merge currentSymbol to the front
  useEffect(() => {
    const merged = mergeSymbol(currentSymbol, loadRecent());
    setRecentSymbols(merged);
    saveRecent(merged);
  }, [currentSymbol]);

  function handleChange(symbol: string) {
    router.push(`/dashboard?symbol=${symbol}`);
  }

  return (
    <Select value={currentSymbol} onValueChange={handleChange}>
      <SelectTrigger className="w-44 border-zinc-700 bg-zinc-900 text-zinc-100">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="border-zinc-700 bg-zinc-900 text-zinc-100">
        {recentSymbols.map((symbol) => (
          <SelectItem key={symbol} value={symbol}>
            {symbol}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
