export const STORAGE_KEY = "recentSymbols";
export const MAX_RECENT = 8;

export function loadRecent(): string[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function saveRecent(symbols: string[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(symbols));
  } catch {
    // sessionStorage unavailable — silently ignore
  }
}

export function mergeSymbol(current: string, existing: string[]): string[] {
  const deduped = [current, ...existing.filter((s) => s !== current)];
  return deduped.slice(0, MAX_RECENT);
}
