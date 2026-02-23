export type ViewMode = "default" | "split" | "multi";

export interface DashboardParams {
  symbol: string;
  view: ViewMode;
  symbol2: string | null;
  symbol3: string | null;
}

export const SYMBOL_RE = /^[A-Z]{1,10}$/;

function sanitizeSymbol(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string") return null;
  const stripped = raw.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10);
  return SYMBOL_RE.test(stripped) ? stripped : null;
}

export function parseDashboardParams(
  raw: Record<string, string | string[] | undefined>
): DashboardParams {
  const symbol = typeof raw.symbol === "string"
    ? raw.symbol.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10)
    : "";
  const view = (raw.view === "split" || raw.view === "multi")
    ? raw.view
    : "default";
  const symbol2 = sanitizeSymbol(raw.symbol2);
  const symbol3 = sanitizeSymbol(raw.symbol3);
  return { symbol, view, symbol2, symbol3 };
}
