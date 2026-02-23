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
import { loadRecent, saveRecent, mergeSymbol } from "@/lib/session";

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
