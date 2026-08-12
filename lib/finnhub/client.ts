import "server-only";
import process from "node:process";

import type {
  FinnhubCandles,
  FinnhubNewsArticle,
  FinnhubProfile,
  FinnhubQuote,
  FinnhubSearchResponse,
} from "./types";

const BASE_URL = "https://finnhub.io/api/v1";

/**
 * Default wall-clock budget for a single Finnhub call, covering both the
 * response headers and the body.
 *
 * Without a timeout a hung upstream connection holds the Route Handler open
 * indefinitely — `fetch` has no default timeout in either Node or Deno. Every
 * route that reaches Finnhub already treats a thrown error as a 500, so a
 * timeout degrades exactly like any other upstream failure.
 */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * A Finnhub response that arrived with a non-2xx status.
 *
 * A distinct class rather than a bare Error because this failure is already
 * fully classified — the status code is the single most useful thing in the
 * log, and 429 in particular is the only direct evidence that the shared free
 * tier key is exhausted. `finnhubFetch` rethrows it untouched so the timeout
 * wrapper below can never overwrite it (see the catch block for why that was
 * possible).
 */
export class FinnhubHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FinnhubHttpError";
    this.status = status;
  }
}

/** Per-call overrides for a Finnhub request. */
export interface FinnhubRequestOptions {
  /**
   * Wall-clock budget in milliseconds for this call. Defaults to
   * DEFAULT_TIMEOUT_MS. Callers that fan out over many symbols should pass a
   * smaller value so the aggregate route latency stays bounded.
   */
  timeoutMs?: number;
}

function getApiKey(): string {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    throw new Error("FINNHUB_API_KEY environment variable is not set");
  }
  return key;
}

async function finnhubFetch<T>(
  path: string,
  options: FinnhubRequestOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${BASE_URL}${path}`;
  const safePath = new URL(url).pathname;

  // An explicit AbortController plus clearTimeout in `finally` rather than
  // AbortSignal.timeout(): the timer is guaranteed to be released as soon as
  // the call settles, so neither the server nor `deno test` is left holding a
  // pending timer per request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    const response = await fetch(url, {
      headers: { "X-Finnhub-Token": getApiKey() },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable body)");
      const detail = process.env.NODE_ENV === "development" ? ` — ${body}` : "";
      throw new FinnhubHttpError(
        response.status,
        `Finnhub request failed: ${response.status} ${safePath}${detail}`
      );
    }

    // Awaited inside the try so a stalled body read is covered by the same
    // timeout as the headers, and surfaces as the timeout error below.
    return (await response.json()) as T;
  } catch (err) {
    // Checked BEFORE the abort check, not after. Reading the error body of a
    // non-ok response takes time, so the abort timer can fire while it is in
    // flight; `response.text()` swallows its own rejection, the status error is
    // thrown anyway, and the signal is aborted by the time it lands here.
    // Deciding on `signal.aborted` alone therefore rewrote a genuine Finnhub
    // 429 or 5xx as "timed out after Nms" and threw the status code away —
    // exactly the diagnostic needed to recognise shared-key exhaustion.
    if (err instanceof FinnhubHttpError) throw err;

    if (controller.signal.aborted) {
      throw new Error(
        `Finnhub request timed out after ${timeoutMs}ms: ${safePath}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchSymbols(
  query: string,
  options?: FinnhubRequestOptions
): Promise<FinnhubSearchResponse> {
  return await finnhubFetch<FinnhubSearchResponse>(
    `/search?q=${encodeURIComponent(query)}`,
    options
  );
}

export async function getQuote(
  symbol: string,
  options?: FinnhubRequestOptions
): Promise<FinnhubQuote> {
  return await finnhubFetch<FinnhubQuote>(
    `/quote?symbol=${encodeURIComponent(symbol)}`,
    options
  );
}

export async function getCandles(
  symbol: string,
  from: number,
  to: number,
  options?: FinnhubRequestOptions
): Promise<FinnhubCandles> {
  return await finnhubFetch<FinnhubCandles>(
    `/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}`,
    options
  );
}

export async function getCompanyProfile(
  symbol: string,
  options?: FinnhubRequestOptions
): Promise<FinnhubProfile> {
  return await finnhubFetch<FinnhubProfile>(
    `/stock/profile2?symbol=${encodeURIComponent(symbol)}`,
    options
  );
}

export async function getCompanyNews(
  symbol: string,
  from: string,
  to: string,
  options?: FinnhubRequestOptions
): Promise<FinnhubNewsArticle[]> {
  return await finnhubFetch<FinnhubNewsArticle[]>(
    `/company-news?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    options
  );
}
