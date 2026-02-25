"use client";

import { useState, useEffect, useRef } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { CandlesResponse, ChartRange } from "@/lib/finnhub/types";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler
);

const RANGES: ChartRange[] = ["1M", "3M", "1Y"];

interface Props {
  symbol: string;
  compact?: boolean;
}

export default function StockChart({ symbol, compact }: Props) {
  const [range, setRange] = useState<ChartRange>("3M");
  const [candles, setCandles] = useState<CandlesResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chartRef = useRef<ChartJS<"line"> | null>(null);

  useEffect(() => {
    setCandles(null);
    setError(null);
    setIsLoading(true);

    fetch(`/api/stock/candles?symbol=${symbol}&range=${range}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch candles");
        return res.json() as Promise<CandlesResponse>;
      })
      .then((data) => {
        if (data.s === "no_data") {
          setError("No historical data available for this symbol.");
        } else {
          setCandles(data);
        }
        setIsLoading(false);
      })
      .catch(() => {
        setError("Unable to load chart data. Please try again.");
        setIsLoading(false);
      });
  }, [symbol, range]);

  function getGradient(ctx: CanvasRenderingContext2D, chartArea: { top: number; bottom: number }) {
    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gradient.addColorStop(0, "rgba(255, 255, 255, 0.15)");
    gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
    return gradient;
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const labels =
    candles?.t.map((ts) =>
      new Date(ts * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    ) ?? [];

  const chartData = {
    labels,
    datasets: [
      {
        data: candles?.c ?? [],
        borderColor: "rgba(255, 255, 255, 0.9)",
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        fill: true,
        backgroundColor: (context: { chart: ChartJS<"line"> }) => {
          const chart = context.chart;
          const { ctx, chartArea } = chart;
          if (!chartArea) return "rgba(255,255,255,0)";
          return getGradient(ctx, chartArea);
        },
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: { display: false },
      tooltip: {
        mode: "index" as const,
        intersect: false,
        callbacks: {
          label: (context: { parsed: { y: number } }) =>
            `$${context.parsed.y.toFixed(2)}`,
        },
        backgroundColor: "rgba(24, 24, 27, 0.95)",
        borderColor: "rgba(63, 63, 70, 1)",
        borderWidth: 1,
        titleColor: "#a1a1aa",
        bodyColor: "#f4f4f5",
      },
    },
    scales: {
      x: {
        grid: { color: "rgba(63, 63, 70, 0.4)" },
        ticks: {
          color: "#71717a",
          maxTicksLimit: 6,
          maxRotation: 0,
        },
        border: { color: "rgba(63, 63, 70, 0.6)" },
      },
      y: {
        grid: { color: "rgba(63, 63, 70, 0.4)" },
        ticks: {
          color: "#71717a",
          callback: (value: number | string) => `$${Number(value).toFixed(0)}`,
        },
        border: { color: "rgba(63, 63, 70, 0.6)" },
        position: "right" as const,
      },
    },
    interaction: {
      mode: "index" as const,
      intersect: false,
    },
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className={`font-medium uppercase tracking-widest text-zinc-500 ${compact ? "text-[10px] sm:text-xs md:text-sm" : "text-sm"}`}>
          Price History
        </h2>
        <div className="flex overflow-hidden rounded-md border border-zinc-700">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`font-medium transition-colors ${compact ? "px-2 py-0.5 text-[10px] sm:px-3 sm:py-1 sm:text-xs" : "px-3 py-1 text-xs"} ${
                range === r
                  ? "bg-zinc-100 text-zinc-900"
                  : "bg-transparent text-zinc-400 hover:text-zinc-100"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className={`relative ${compact ? "h-36 sm:h-44 md:h-52" : "h-72"} w-full`}>
        {isLoading ? (
          <div className="absolute inset-0 animate-pulse motion-reduce:animate-none rounded-lg bg-zinc-800" />
        ) : candles ? (
          <Line
            ref={chartRef}
            data={chartData}
            options={options}
          />
        ) : null}
      </div>
    </div>
  );
}
