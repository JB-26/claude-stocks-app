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

/**
 * Returns a human-readable string describing when the US market next opens.
 * Examples: "today at 9:30 AM ET", "Monday at 9:30 AM ET"
 */
export function getNextMarketOpenLabel(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";

  const weekday = get("weekday");
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  const timeInMinutes = hour * 60 + minute;

  const weekdays = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const dayIndex = weekdays.indexOf(weekday);

  // If it's a weekday and before market open (9:30 AM = 570 min), it opens today
  if (dayIndex >= 1 && dayIndex <= 5 && timeInMinutes < 570) {
    return "today at 9:30 AM ET";
  }

  // Otherwise, find the next weekday
  // After market close on Friday (dayIndex 5) or weekend → next Monday
  // After market close on weekday → next weekday
  if (dayIndex === 5 && timeInMinutes >= 960) {
    return "Monday at 9:30 AM ET";
  }
  if (dayIndex === 6) {
    return "Monday at 9:30 AM ET";
  }
  if (dayIndex === 0) {
    return "Monday at 9:30 AM ET";
  }

  // Weekday, after market close → tomorrow
  const tomorrowIndex = dayIndex + 1;
  return `${weekdays[tomorrowIndex]} at 9:30 AM ET`;
}
