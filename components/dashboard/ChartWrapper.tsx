"use client";

import dynamic from "next/dynamic";

const StockChart = dynamic(() => import("./StockChart"), {
  ssr: false,
  loading: () => (
    <div className="h-72 w-full animate-pulse rounded-lg bg-zinc-800" />
  ),
});

interface Props {
  symbol: string;
}

export default function ChartWrapper({ symbol }: Props) {
  return <StockChart symbol={symbol} />;
}
