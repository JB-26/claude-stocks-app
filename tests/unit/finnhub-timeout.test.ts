import { assert, assertEquals, assertRejects } from "@std/assert";

// ---------------------------------------------------------------------------
// finnhub-timeout.test.ts
//
// Covers the per-request timeout added to lib/finnhub/client.ts.
//
// `fetch` has no default timeout in either Node or Deno, so before this an
// upstream connection that accepted the socket and then went silent would hold
// a Route Handler open indefinitely — and on the watchlist route, hold one of
// only five concurrency slots with it.
//
// Deno's test sanitizers are load-bearing here: if the client failed to clear
// its timeout timer on the success path, the "fast response" test below would
// fail with a leaked-timer error rather than passing quietly.
// ---------------------------------------------------------------------------

import { FinnhubHttpError, getQuote } from "../../lib/finnhub/client.ts";

const API_KEY = "test-key-123";

/** A fetch stub that never responds, but honours the AbortSignal it is given. */
function stubHangingFetch(): { restore: () => void; sawSignal: () => boolean } {
  const original = globalThis.fetch;
  let sawSignal = false;

  globalThis.fetch = ((
    _input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const signal = init?.signal;
    sawSignal = signal instanceof AbortSignal;

    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The signal has been aborted", "AbortError")),
        { once: true }
      );
    });
  }) as typeof globalThis.fetch;

  return {
    restore: () => {
      globalThis.fetch = original;
    },
    sawSignal: () => sawSignal,
  };
}

// ---------------------------------------------------------------------------
// FT-01: a hung upstream is aborted rather than hanging the caller forever
// ---------------------------------------------------------------------------

Deno.test("finnhub-timeout FT-01: a hung upstream request is aborted and rejects with a timeout error", async () => {
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const stub = stubHangingFetch();

  try {
    const error = await assertRejects(
      () => getQuote("AAPL", { timeoutMs: 25 }),
      Error
    );

    assert(
      error.message.includes("timed out"),
      `expected a timeout error, got: ${error.message}`
    );
    assert(
      error.message.includes("25ms"),
      `the error should name the budget it exceeded, got: ${error.message}`
    );
    // The path is safe to log; the API key lives in a header, never the URL.
    assert(
      error.message.includes("/api/v1/quote"),
      `the error should name the endpoint, got: ${error.message}`
    );
    assert(!error.message.includes(API_KEY), "the API key must never be logged");
  } finally {
    stub.restore();
  }
});

Deno.test("finnhub-timeout FT-02: the client passes an AbortSignal to fetch", async () => {
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const stub = stubHangingFetch();

  try {
    await assertRejects(() => getQuote("AAPL", { timeoutMs: 20 }));
    assert(stub.sawSignal(), "fetch must receive an AbortSignal");
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// FT-03: the timeout never fires — or leaks a timer — on a normal response
// ---------------------------------------------------------------------------

Deno.test("finnhub-timeout FT-03: a fast response resolves normally and leaves no pending timer", async () => {
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const original = globalThis.fetch;
  const payload = {
    c: 150,
    d: 1.5,
    dp: 1,
    h: 152,
    l: 148,
    o: 149,
    pc: 148.5,
    t: 1_700_000_000,
  };

  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))) as typeof globalThis.fetch;

  try {
    // A 10-minute budget: if the timer were not cleared on success, Deno's op
    // sanitizer would fail this test rather than let it pass.
    assertEquals(await getQuote("AAPL", { timeoutMs: 600_000 }), payload);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// FT-04: existing callers that pass no options still work
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FT-05: a real HTTP error is never rewritten as a timeout
//
// The timeout wrapper decides what happened by inspecting the AbortController.
// Reading the error body of a non-ok response takes time, so the timer can fire
// while `response.text()` is in flight: `.catch()` swallows the body read's own
// rejection, the status error is thrown anyway, and by the time it reaches the
// catch block `signal.aborted` is true. Deciding on that flag alone turned a
// genuine Finnhub 429 into "timed out after 25ms" and threw the status code
// away — and 429 on the shared free-tier key is the single most important thing
// to be able to see in the logs.
// ---------------------------------------------------------------------------

/** A fetch stub that answers with a status but whose body read never returns. */
function stubStatusWithHangingBody(status: number): { restore: () => void } {
  const original = globalThis.fetch;

  globalThis.fetch = ((
    _input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const signal = init?.signal;
    const hang = <T>(): Promise<T> =>
      new Promise<T>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The signal has been aborted", "AbortError")),
          { once: true }
        );
      });

    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => hang<string>(),
      json: () => hang<unknown>(),
    } as unknown as Response);
  }) as typeof globalThis.fetch;

  return {
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

Deno.test("finnhub-timeout FT-05: a 429 whose body read is cut short by the timer still reports as a 429", async () => {
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const stub = stubStatusWithHangingBody(429);

  try {
    const error = await assertRejects(
      () => getQuote("AAPL", { timeoutMs: 25 }),
      FinnhubHttpError
    );

    assertEquals(error.status, 429);
    assert(
      error.message.includes("429"),
      `the status must survive, got: ${error.message}`
    );
    assert(
      !error.message.includes("timed out"),
      `a status error must not be relabelled as a timeout, got: ${error.message}`
    );
    assert(!error.message.includes(API_KEY), "the API key must never be logged");
  } finally {
    stub.restore();
  }
});

Deno.test("finnhub-timeout FT-05b: a 500 is likewise preserved rather than relabelled", async () => {
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const stub = stubStatusWithHangingBody(500);

  try {
    const error = await assertRejects(
      () => getQuote("AAPL", { timeoutMs: 25 }),
      FinnhubHttpError
    );
    assertEquals(error.status, 500);
  } finally {
    stub.restore();
  }
});

Deno.test("finnhub-timeout FT-05c: a stalled body on a 200 response IS still a timeout", async () => {
  // The guard above must not over-correct: a successful status whose body never
  // arrives is exactly what the timeout exists to catch.
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const stub = stubStatusWithHangingBody(200);

  try {
    const error = await assertRejects(
      () => getQuote("AAPL", { timeoutMs: 25 }),
      Error
    );

    assert(
      error.message.includes("timed out"),
      `expected a timeout error, got: ${error.message}`
    );
    assert(
      !(error instanceof FinnhubHttpError),
      "a 200 with a stalled body is a timeout, not an HTTP status error"
    );
  } finally {
    stub.restore();
  }
});

Deno.test("finnhub-timeout FT-04: omitting options keeps the existing call signature working", async () => {
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const original = globalThis.fetch;
  const payload = {
    c: 1,
    d: 0,
    dp: 0,
    h: 1,
    l: 1,
    o: 1,
    pc: 1,
    t: 1,
  };

  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))) as typeof globalThis.fetch;

  try {
    assertEquals(await getQuote("AAPL"), payload);
  } finally {
    globalThis.fetch = original;
  }
});
