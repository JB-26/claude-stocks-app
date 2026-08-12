"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatPrice, formatChange, formatPercent } from "@/lib/utils";
import type { WatchlistQuotesResponse } from "@/lib/finnhub/types";
import {
  hasAnyDisplayablePrice,
  hasPrice,
  mergeQuotesResponse,
  pruneToCurrentSymbols,
  computeShowDegradedBanner,
  type QuoteState,
} from "@/lib/watchlist-panel-logic";

/** How often (ms) to re-fetch quotes while the tab is visible. Mirrors
 * PriceHeader's poll interval — the panel and any open dashboard tab share
 * the same 60s server-side quote cache, so there's no upstream cost benefit
 * to polling faster or slower than the dashboard does. */
const POLL_INTERVAL_MS = 60_000;

interface Props {
  symbols: string[];
  onRemove: (symbol: string) => void;
}

/**
 * The 429 case and "everything else failed" case need different shapes:
 * only rate-limiting has a server-given wait time that ticks down and a
 * message that changes as it does. Modeling them as one discriminated union
 * (rather than a single `message` string computed once at set-time) means
 * the rendered copy is always derived fresh from the current
 * `retryAfterSeconds`, so it can never go stale the way a frozen message
 * string can.
 */
type FetchErrorState =
  | { kind: "rateLimited"; retryAfterSeconds: number | null }
  | { kind: "generic"; message: string };

/**
 * WatchlistPanel — fetches and renders live quotes for the user's saved
 * symbols, polling on the same lifecycle PriceHeader uses.
 *
 * Deliberately does NOT use useRetryableFetch: the symbol list is already
 * fully known from localStorage independent of the fetch outcome, so on
 * total fetch failure every row must still render (symbol + working
 * dashboard link) in a degraded state rather than collapsing to a single
 * all-or-nothing error view. Rows never disappear — that's the behavior
 * that distinguishes this panel from the decorative TickerTape/movers strip.
 *
 * A *response* can also be degraded without being a fetch failure at all:
 * the server returns HTTP 200 with some rows marked `status: "error"` when
 * its upstream Finnhub budget is spent (`reason: "deferred"`) or a call
 * genuinely failed (`reason: "failed"`). Those two reasons are NOT
 * equivalent to `reason: "unavailable"` (the symbol itself has no data) and
 * must be handled differently — see the merge logic below and
 * `QuoteDisplay`.
 */
export default function WatchlistPanel({ symbols, onRemove }: Props) {
  // Keyed by symbol so a partial response never clobbers unrelated rows.
  // NOTE: keying alone does NOT protect against an *out-of-order* response
  // for the same symbol — a slow request landing after a faster, newer one
  // would still overwrite fresh data with stale data. That's handled
  // separately below via a generation counter + AbortController, not by
  // this Map's keying.
  const [quotes, setQuotes] = useState<Map<string, QuoteState>>(new Map());
  const [fetchError, setFetchError] = useState<FetchErrorState | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  // Plain counter driving the countdown, updated directly (not via a state
  // updater) so the interval tick never needs to read-then-write React
  // state impurely — it just computes the next number and hands it to
  // setFetchError as a single, pure value.
  const retrySecondsRef = useRef<number | null>(null);

  // Always-current symbols for the fetch closure below, without making the
  // mount effect re-run (and re-fetch) on every add/remove — a pure removal
  // must NOT by itself trigger a re-fetch, since the remaining rows' data is
  // unchanged. (Additions are handled by the separate effect further down.)
  const symbolsRef = useRef(symbols);

  // Always-current quotes for the fetch closure below (same "ref mirror"
  // technique as symbolsRef). Needed so the 429 and total-failure branches
  // can check "is the panel warm right now" by reading a live value instead
  // of either closing over a stale `quotes` from whenever fetchQuotes was
  // created, or peeking at it from inside a setQuotes updater (impure —
  // updaters must have no side effects, and must be safe to call more than
  // once, which "start a setInterval" is not).
  const quotesRef = useRef(quotes);

  // Keep both refs in sync on every render — but in an effect, not by
  // writing `.current` directly in the render body. React's own docs (and
  // its compiler's validateNoRefAccessInRender check) call that unsafe: a
  // render that gets discarded (e.g. under a Suspense fallback or a
  // transition) would still have mutated the ref, since ref writes aren't
  // part of the render/commit contract the way state is. Nothing on this
  // component's path uses Suspense or transitions today, so the old
  // direct-write version didn't currently misbehave, but doing it correctly
  // costs nothing here. These have no dependency array so they re-run after
  // every commit, and are declared before the effects below that call
  // fetchQuotes so those effects always observe the just-updated values.
  useEffect(() => {
    symbolsRef.current = symbols;
  });
  useEffect(() => {
    quotesRef.current = quotes;
  });

  // Out-of-order response protection: starting a new fetch aborts whatever
  // request is already in flight (in-flight guard) and bumps `generation`.
  // A response is only ever applied to state if it's still the current
  // generation when it resolves (stale-response rejection) — a necessary
  // backstop on top of abort(), since abort() can't guarantee a response
  // that's already in transit won't resolve before the abort takes effect.
  // Also bumped on unmount (see the cleanup below) so a response that
  // resolves after the component is gone can never start a setInterval on
  // a dead component.
  const abortControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  // What symbols we've already seen, so the symbols-effect below can tell
  // "a symbol was added" (fetch it promptly) apart from "a symbol was
  // removed" (must NOT trigger a fetch — see that effect for why).
  const prevSymbolSetRef = useRef<Set<string>>(new Set(symbols));

  const clearCountdownTimer = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  const fetchQuotes = useCallback(() => {
    const currentSymbols = symbolsRef.current;
    if (currentSymbols.length === 0) return;

    clearCountdownTimer();

    // In-flight guard: supersede rather than stack. Whatever request was
    // already running is now stale regardless of how its promise settles.
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const generation = ++generationRef.current;

    fetch(`/api/stock/watchlist-quotes?symbols=${currentSymbols.join(",")}`, {
      signal: controller.signal,
    })
      .then((res) => {
        // A newer fetch started while this one was in flight — let it own
        // the UI; don't act on this response at all, success or failure.
        if (generation !== generationRef.current) return undefined;

        if (res.status === 429) {
          const retryHeader = res.headers.get("Retry-After");
          const seconds = retryHeader ? parseInt(retryHeader, 10) : 60;
          const validSeconds =
            Number.isFinite(seconds) && seconds > 0 ? seconds : 60;

          // Only surface (and tick down) a rate-limit banner when it would
          // actually be visible — i.e. the panel is still cold (holds no
          // real price data yet). On a warm panel, a 429 on a background
          // poll is silent, exactly like any other poll failure once real
          // data is showing (see the catch branch below). Ticking a
          // countdown for a banner nobody can see would just re-render
          // every card in the list once a second for nothing on screen.
          //
          // Deliberately `hasAnyDisplayablePrice`, not `quotesRef.current.size
          // === 0`: a fully budget-denied cold start populates one entry per
          // requested symbol (all `status: "error"`), so `size` alone can't
          // tell "cold" from "warm but every row happens to be an error".
          if (!hasAnyDisplayablePrice(quotesRef.current)) {
            retrySecondsRef.current = validSeconds;
            setFetchError({ kind: "rateLimited", retryAfterSeconds: validSeconds });

            countdownTimerRef.current = setInterval(() => {
              const remaining = retrySecondsRef.current;
              if (remaining === null || remaining <= 1) {
                retrySecondsRef.current = null;
                clearCountdownTimer();
                setFetchError({ kind: "rateLimited", retryAfterSeconds: null });
                return;
              }
              retrySecondsRef.current = remaining - 1;
              setFetchError({
                kind: "rateLimited",
                retryAfterSeconds: remaining - 1,
              });
            }, 1_000);
          }

          return undefined;
        }

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<WatchlistQuotesResponse>;
      })
      .then((data) => {
        if (!data) return; // 429 branch (handled above) or a stale response
        if (generation !== generationRef.current) return;

        setFetchError(null);
        // Merge fresh data in and prune any symbol no longer on the
        // watchlist in the same pass. Pruning matters here too, not just in
        // the symbols-effect below: a symbol removed while this request was
        // in flight (and possibly re-added elsewhere before it resolved)
        // must not have its pre-removal price applied as if it were
        // current. See lib/watchlist-panel-logic.ts for the merge rules
        // (imported here, and by tests/unit/watchlist.test.ts, from the
        // same module — not re-implemented in either place).
        setQuotes((prev) =>
          mergeQuotesResponse(prev, data.quotes, symbolsRef.current)
        );
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (generation !== generationRef.current) return;

        // Total fetch failure (network error, 5xx): leave existing quote
        // state untouched. Rows with previously-fetched data keep showing
        // their last-known price; the panel itself never disappears. Only
        // surface an error when nothing has EVER loaded a real price —
        // otherwise the skeleton has no way to signal it's actually broken
        // rather than just slow, and would spin forever. Once any row has
        // real data, subsequent poll failures stay silent, same as
        // PriceHeader.
        //
        // Deliberately `hasAnyDisplayablePrice`, not `quotesRef.current.size
        // === 0` — see the matching comment on the 429 branch above for why
        // Map-has-keys is the wrong proxy for "the panel is cold".
        if (!hasAnyDisplayablePrice(quotesRef.current)) {
          setFetchError({
            kind: "generic",
            message: "Unable to load watchlist prices. Please try again.",
          });
        }
      });
  }, [clearCountdownTimer]);

  // ─── Initial fetch + polling (mirrors PriceHeader's lifecycle) ───────────
  useEffect(() => {
    fetchQuotes();

    function startInterval() {
      if (intervalRef.current !== null) return;
      intervalRef.current = setInterval(fetchQuotes, POLL_INTERVAL_MS);
    }

    function clearIntervalRef() {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    // Pause polling when the tab goes to the background; resume with an
    // immediate re-fetch when it returns to the foreground. Calling
    // fetchQuotes() here even if a poll is already mid-flight is safe —
    // its own in-flight guard supersedes rather than stacks.
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        clearIntervalRef();
      } else {
        fetchQuotes();
        startInterval();
      }
    }

    if (document.visibilityState === "visible") {
      startInterval();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearIntervalRef();
      clearCountdownTimer();
      abortControllerRef.current?.abort();
      // Belt-and-suspenders alongside abort(): if a response for the
      // in-flight request resolves after this cleanup runs (a single
      // microtask racing the abort signal taking effect), bumping the
      // generation here means the `generation !== generationRef.current`
      // guard in every branch above still rejects it, so a 429 can't start
      // a setInterval ticking forever on an unmounted component.
      generationRef.current++;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // Intentionally mount-once: `fetchQuotes` is a stable callback that
    // always reads the latest symbols via symbolsRef, so a pure removal
    // doesn't need to (and must not) tear down and restart this effect. New
    // symbols are NOT covered by this invariant, though — see the
    // symbols-effect below, which exists specifically because this effect
    // not re-running means additions would otherwise wait for the next
    // scheduled poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── React to symbol list changes (add/remove, incl. cross-tab) ──────────
  useEffect(() => {
    const prevSymbols = prevSymbolSetRef.current;
    const currentSymbols = new Set(symbols);
    const hasNewSymbol = symbols.some((s) => !prevSymbols.has(s));
    prevSymbolSetRef.current = currentSymbols;

    // Prune quotes for symbols no longer on the list immediately, instead
    // of waiting for the next poll response to do it — otherwise a removed
    // (and possibly since re-added elsewhere) symbol keeps rendering its
    // old, pre-removal price as if it were still live.
    setQuotes((prev) => {
      const next = pruneToCurrentSymbols(prev, currentSymbols);
      // pruneToCurrentSymbols only ever removes entries, never adds — equal
      // size means nothing was pruned, so bail out to `prev` and skip the
      // re-render.
      return next.size === prev.size ? prev : next;
    });

    // A symbol appearing that we didn't already know about (e.g. saved from
    // the dashboard in another tab/window — see useWatchlistSymbols' storage
    // listener) should get its price promptly instead of sitting on a
    // skeleton for up to 60s. A pure removal must NOT trigger this — the
    // remaining rows' prices are unaffected, and re-fetching on every
    // removal would be a refetch storm for no benefit.
    if (hasNewSymbol) {
      fetchQuotes();
    }
  }, [symbols, fetchQuotes]);

  // Deliberately `hasAnyDisplayablePrice`, not `quotes.size === 0`: a fully
  // budget-denied cold start populates one entry per requested symbol (all
  // `status: "error"`), so `size` is nonzero even though the user has never
  // seen a single price. "Is the panel cold" has to mean "do we hold any
  // real, displayable price data", not "does the Map have keys" — otherwise
  // a dead server after a degraded cold start never surfaces a terminal
  // error (see fetchQuotes' catch branch) and the amber "retrying
  // automatically" banner is left showing forever with nothing behind it.
  const showTerminalError =
    fetchError !== null && !hasAnyDisplayablePrice(quotes);

  // A response can be "success-shaped" (HTTP 200) and still represent a
  // real failure the user needs to know about: a fully budget-denied cold
  // start returns 20 `status: "error"` rows with HTTP 200, which takes the
  // success path above and populates `quotes` — so `showTerminalError`
  // (which only fires on an actual fetch failure) stays false even though
  // every row is an em-dash. The same is true of a TOTAL upstream outage
  // (Finnhub down, or the shared rate-limit budget already spent by other
  // routes): every dispatched symbol throws, every row comes back
  // `status: "error", reason: "failed"`, HTTP 200 — and the server's
  // `degraded` flag is FALSE, because it only means "deferred", i.e. a
  // capacity shortage, not "every call failed" (see `isDegraded` in
  // lib/watchlist-quotes-logic.ts). This banner is therefore gated on "is
  // any row currently showing a gap that isn't just this symbol having no
  // data" (`hasVisibleGap`) alone, NOT on `degraded` — a gap the user can
  // see must never depend on the server having volunteered a flag about
  // it. The response's `degraded` field is therefore not read here at all —
  // it stays on the wire as a correct, meaningful server signal, but the
  // client has no reader for it today. See lib/watchlist-panel-logic.ts for
  // the full gating rules (imported here, and by tests/unit/watchlist.test.ts,
  // from the same module — not re-implemented in either place).
  const showDegradedBanner = computeShowDegradedBanner(
    symbols,
    quotes,
    showTerminalError
  );

  return (
    <section aria-label="Your watchlist" className="w-full">
      {showTerminalError && fetchError && (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>
            <div className="flex items-center justify-between gap-2">
              <span>
                {fetchError.kind === "rateLimited"
                  ? fetchError.retryAfterSeconds !== null
                    ? `Too many requests — retry available in ${fetchError.retryAfterSeconds} seconds`
                    : "Too many requests — you can retry now."
                  : fetchError.message}
              </span>
              {(fetchError.kind === "generic" ||
                fetchError.retryAfterSeconds === null) && (
                <button
                  type="button"
                  onClick={() => fetchQuotes()}
                  className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-zinc-100 transition-colors hover:bg-zinc-700"
                >
                  Retry
                </button>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}
      {showDegradedBanner && (
        <Alert
          variant="default"
          className="mb-3 border-amber-900/50 bg-amber-950/20"
        >
          <AlertDescription className="text-amber-200/90">
            {/* "showing what we have" is only true when at least one row
                actually has a price. A total upstream outage clears this
                banner's gate too (hasVisibleGap) but leaves zero rows with a
                price, so that phrase would be actively wrong — say we have
                nothing to show instead of implying a partial result. */}
            {hasAnyDisplayablePrice(quotes)
              ? "Some prices are temporarily unavailable — showing what we have and retrying automatically."
              : "Prices are temporarily unavailable — retrying automatically."}
          </AlertDescription>
        </Alert>
      )}
      <ul className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
        {symbols.map((symbol) => (
          <li key={symbol}>
            <WatchlistCard
              symbol={symbol}
              state={quotes.get(symbol)}
              loadFailed={showTerminalError}
              onRemove={onRemove}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Row rendering
// ---------------------------------------------------------------------------

interface WatchlistCardProps {
  symbol: string;
  state: QuoteState | undefined;
  loadFailed: boolean;
  onRemove: (symbol: string) => void;
}

function WatchlistCard({
  symbol,
  state,
  loadFailed,
  onRemove,
}: WatchlistCardProps) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 transition-colors hover:border-zinc-700">
      {/*
        The card's clickable navigation target and the remove button are
        siblings, not nested — a <button> inside an <a> is invalid HTML and
        would also make "remove" ambiguously also trigger navigation.
      */}
      <Link
        href={`/dashboard?symbol=${symbol}`}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
      >
        <span className="font-mono text-sm font-semibold tracking-wide text-zinc-100">
          {symbol}
        </span>
        <QuoteDisplay state={state} loadFailed={loadFailed} />
      </Link>
      <button
        type="button"
        onClick={() => onRemove(symbol)}
        aria-label={`Remove ${symbol} from watchlist`}
        title="Remove from watchlist"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Renders the price/change portion of a card in one of five states:
 * loading (no entry yet and the fetch hasn't terminally failed —
 * synchronous skeleton, count already correct from `symbols.length`),
 * load-failed (no entry yet AND the initial fetch has terminally failed —
 * em-dash, so the skeleton doesn't pulse forever with no way for the user
 * to know something is actually wrong), ok (formatted price + change,
 * reusing PriceHeader's formatters for visual consistency with the
 * dashboard — the change is omitted, price-only, when the entry has no
 * delta, e.g. an IPO's first session with no previous close), stale-ok (a
 * retained good price whose latest refresh came back "deferred"/"failed" —
 * same formatted price, plus a small affordance flagging it may be out of
 * date), or error (em-dash placeholder, with screen-reader copy that
 * differs by `reason` — the row itself, including its symbol and link,
 * still rendered above).
 *
 * The gate for "does this row have a price to show" is `hasPrice(entry)`,
 * NOT "does it also have a change/changePercent" — a `status: "ok"` row can
 * legitimately have a real price and a null delta at the same time, and
 * demoting that to an em-dash would hide a real, correct price behind a
 * missing (and, per the server contract, entirely optional) delta.
 */
function QuoteDisplay({
  state,
  loadFailed,
}: {
  state: QuoteState | undefined;
  loadFailed: boolean;
}) {
  if (state === undefined) {
    if (loadFailed) {
      return (
        <span className="mt-0.5 block text-xs text-zinc-500">
          <span aria-hidden="true">—</span>
          <span className="sr-only">Price unavailable</span>
        </span>
      );
    }
    return (
      <span
        className="mt-0.5 block h-4 w-20 animate-pulse rounded bg-zinc-800 motion-reduce:animate-none"
        aria-hidden="true"
      />
    );
  }

  const { entry, stale } = state;

  if (!hasPrice(entry)) {
    // "unavailable" is a fact about the symbol (no usable data exists);
    // "deferred"/"failed" (or no reason at all, e.g. a legacy/total-failure
    // placeholder) are transient and will very likely resolve on the next
    // poll — say so, rather than presenting both identically.
    const srText =
      entry.status === "error" && entry.reason === "unavailable"
        ? "No price data available for this symbol"
        : "Price temporarily unavailable — retrying automatically";
    return (
      <span className="mt-0.5 block text-xs text-zinc-500">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{srText}</span>
      </span>
    );
  }

  // hasPrice(entry) is a type predicate, so entry.price is narrowed to
  // `number` from here on; change/changePercent may still be null (no
  // previous close) and, if so, are simply omitted — never treated as a
  // reason to hide the price itself.
  const { change, changePercent } = entry;
  const hasDelta = change !== null && changePercent !== null;

  return (
    <span className="mt-0.5 flex items-baseline gap-2 text-xs">
      <span className="font-medium text-zinc-200">
        {formatPrice(entry.price)}
      </span>
      {hasDelta && (
        <span className={change >= 0 ? "text-green-400" : "text-red-400"}>
          {formatChange(change)} {formatPercent(changePercent)}
        </span>
      )}
      {stale && (
        <span className="font-medium uppercase tracking-wide text-amber-500/80 text-[10px]">
          <span aria-hidden="true">stale</span>
          <span className="sr-only">
            — price may be out of date, the latest refresh failed
          </span>
        </span>
      )}
    </span>
  );
}
