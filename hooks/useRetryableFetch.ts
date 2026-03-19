"use client";

import { useState, useCallback, useRef, useEffect } from "react";

/** Delay (ms) before the automatic retry on 5xx errors. */
const AUTO_RETRY_DELAY_MS = 3_000;

export interface RetryableFetchState<T> {
  /** The successfully fetched data, or null if not yet loaded / after reset. */
  data: T | null;
  /** Human-readable error message, or null when there is no error. */
  error: string | null;
  /** True while the initial fetch or a retry is in flight. */
  isLoading: boolean;
  /** When rate-limited (429), the number of seconds until the client can retry. */
  retryAfterSeconds: number | null;
  /** Manually trigger a retry. Safe to call from a button onClick. */
  retry: () => void;
}

interface Options {
  /** A label used in the generic error message, e.g. "price data". */
  label: string;
}

/**
 * A hook that wraps `fetch` with:
 * - One automatic retry after a 3-second delay for 5xx errors.
 * - Rate-limit awareness: reads the `Retry-After` header on 429 responses and
 *   exposes a countdown so the UI can show "retrying in X seconds".
 * - A manual `retry()` function for a "Retry" button.
 *
 * The hook re-fetches whenever `url` changes. Passing `null` for `url` skips
 * fetching entirely (useful when a required parameter is not yet available).
 */
export function useRetryableFetch<T>(
  url: string | null,
  { label }: Options
): RetryableFetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(
    null
  );

  // Track whether an auto-retry for 5xx has already been attempted for the
  // current url so we only retry once automatically.
  const hasAutoRetriedRef = useRef(false);

  // Store the latest url in a ref so timers/callbacks always see the current value.
  const urlRef = useRef(url);
  urlRef.current = url;

  // Abort controller ref to cancel in-flight requests on url change or unmount.
  const abortRef = useRef<AbortController | null>(null);

  // Timer refs for cleanup.
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (autoRetryTimerRef.current !== null) {
      clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
    }
    if (countdownTimerRef.current !== null) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  const doFetch = useCallback(
    (fetchUrl: string, isAutoRetry: boolean) => {
      // Cancel any previous request.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsLoading(true);
      setError(null);
      setRetryAfterSeconds(null);
      clearTimers();

      fetch(fetchUrl, { signal: controller.signal })
        .then((res) => {
          if (res.status === 429) {
            const retryHeader = res.headers.get("Retry-After");
            const seconds = retryHeader ? parseInt(retryHeader, 10) : 60;
            const validSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
            setRetryAfterSeconds(validSeconds);

            // Start a visible countdown.
            countdownTimerRef.current = setInterval(() => {
              setRetryAfterSeconds((prev) => {
                if (prev === null || prev <= 1) {
                  if (countdownTimerRef.current !== null) {
                    clearInterval(countdownTimerRef.current);
                    countdownTimerRef.current = null;
                  }
                  return null;
                }
                return prev - 1;
              });
            }, 1_000);

            setError(`Too many requests — retry available in ${validSeconds} seconds`);
            setIsLoading(false);
            return;
          }

          if (res.status >= 500) {
            // Auto-retry once for server errors.
            if (!isAutoRetry && !hasAutoRetriedRef.current) {
              hasAutoRetriedRef.current = true;
              autoRetryTimerRef.current = setTimeout(() => {
                // Only retry if the url hasn't changed.
                if (urlRef.current === fetchUrl) {
                  doFetch(fetchUrl, true);
                }
              }, AUTO_RETRY_DELAY_MS);
              // Keep isLoading true during the auto-retry delay.
              return;
            }
            throw new Error(`Server error (${res.status})`);
          }

          if (!res.ok) {
            throw new Error(`Request failed (${res.status})`);
          }

          return res.json() as Promise<T>;
        })
        .then((parsed) => {
          // `parsed` is undefined when we early-returned for 429 or auto-retry.
          if (parsed !== undefined) {
            setData(parsed);
            setError(null);
            setIsLoading(false);
          }
        })
        .catch((err: unknown) => {
          // Ignore aborted requests — they are intentional.
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(`Unable to load ${label}. Please try again.`);
          setIsLoading(false);
        });
    },
    [label, clearTimers]
  );

  // Main effect: fetch on url change.
  useEffect(() => {
    if (url === null) {
      setData(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    // Reset auto-retry tracking for the new url.
    hasAutoRetriedRef.current = false;
    setData(null);

    doFetch(url, false);

    return () => {
      abortRef.current?.abort();
      clearTimers();
    };
  }, [url, doFetch, clearTimers]);

  const retry = useCallback(() => {
    if (urlRef.current === null) return;
    hasAutoRetriedRef.current = false;
    doFetch(urlRef.current, false);
  }, [doFetch]);

  return { data, error, isLoading, retryAfterSeconds, retry };
}
