interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const MAX_ENTRIES = 1000;

const store = new Map<string, CacheEntry<unknown>>();

if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.expiresAt) store.delete(key);
    }
  }, 5 * 60_000);
}

export function getCached<T>(key: string): T | null {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.data;
}

export function setCached<T>(key: string, value: T, ttlMs: number): void {
  if (store.size >= MAX_ENTRIES) {
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey);
  }
  store.set(key, { data: value, expiresAt: Date.now() + ttlMs });
}
