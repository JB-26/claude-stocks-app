import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ---------------------------------------------------------------------------
// Number formatters
// ---------------------------------------------------------------------------

export function formatPrice(price: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(price);
}

export function formatChange(change: number): string {
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(2)}`;
}

export function formatPercent(percent: number): string {
  const sign = percent >= 0 ? "+" : "";
  return `(${sign}${percent.toFixed(2)}%)`;
}

// ---------------------------------------------------------------------------
// Market hours
// ---------------------------------------------------------------------------

/**
 * Returns true when the NYSE is currently open.
 * Uses NYSE regular trading hours: Mon–Fri, 09:30–16:00 ET.
 * Does not account for market holidays (planned future enhancement).
 */
export function isMarketOpen(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";

  const weekday = get("weekday");
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);

  const isWeekday = weekday !== "Sat" && weekday !== "Sun";
  const timeInMinutes = hour * 60 + minute;

  // 9:30 AM = 570 min, 4:00 PM = 960 min
  return isWeekday && timeInMinutes >= 570 && timeInMinutes < 960;
}
