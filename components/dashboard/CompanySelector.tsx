"use client";

import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  currentSymbol: string;
}

export default function CompanySelector({ currentSymbol }: Props) {
  const router = useRouter();

  return (
    <Select
      value={currentSymbol}
      onValueChange={(symbol) => router.push(`/dashboard?symbol=${symbol}`)}
    >
      <SelectTrigger className="w-44 border-zinc-700 bg-zinc-900 text-zinc-100">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="border-zinc-700 bg-zinc-900 text-zinc-100">
        <SelectItem value={currentSymbol}>{currentSymbol}</SelectItem>
      </SelectContent>
    </Select>
  );
}
