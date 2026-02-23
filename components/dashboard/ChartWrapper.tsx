"use client";

import dynamic from "next/dynamic";

const StockChart = dynamic(() => import("./StockChart"), {
  ssr: false,
});

interface Props {
  symbol: string;
  compact?: boolean;
}

export default function ChartWrapper({ symbol, compact }: Props) {
  const heightClass = compact ? "h-52" : "h-72";

  return (
    <div className={heightClass}>
      <StockChart symbol={symbol} compact={compact} />
    </div>
  );
}
