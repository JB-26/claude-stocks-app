import { assertEquals } from "@std/assert";
import {
  getCandles,
  getCompanyNews,
  getQuote,
  searchSymbols,
} from "../../lib/finnhub/client.ts";

const API_KEY = "test-key-123";
const BASE = "https://finnhub.io/api/v1";

// ---------------------------------------------------------------------------
// Helper: replaces globalThis.fetch with a controlled stub, returns a teardown
// ---------------------------------------------------------------------------

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(
  data: unknown,
  status = 200
): { captured: CapturedCall; restore: () => void } {
  const original = globalThis.fetch;
  const captured: CapturedCall = { url: "", init: undefined };

  globalThis.fetch = ((
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    captured.url = input.toString();
    captured.init = init;
    return Promise.resolve(
      new Response(JSON.stringify(data), { status })
    );
  }) as typeof globalThis.fetch;

  return { captured, restore: () => { globalThis.fetch = original; } };
}

// ---------------------------------------------------------------------------
// searchSymbols
// ---------------------------------------------------------------------------

Deno.test("searchSymbols: calls the correct Finnhub URL", async () => {
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const mockData = { count: 2, result: [] };
  const { captured, restore } = stubFetch(mockData);
  try {
    await searchSymbols("Apple");
    assertEquals(captured.url, `${BASE}/search?q=Apple`);
  } finally {
    restore();
  }
});

Deno.test("searchSymbols: attaches X-Finnhub-Token header", async () => {
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const { captured, restore } = stubFetch({ count: 0, result: [] });
  try {
    await searchSymbols("x");
    assertEquals(
      (captured.init?.headers as Record<string, string>)["X-Finnhub-Token"],
      API_KEY
    );
  } finally {
    restore();
  }
});

Deno.test("searchSymbols: URL-encodes the query string", async () => {
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const { captured, restore } = stubFetch({ count: 0, result: [] });
  try {
    await searchSymbols("S&P 500");
    assertEquals(captured.url, `${BASE}/search?q=S%26P%20500`);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// getQuote
// ---------------------------------------------------------------------------

Deno.test("getQuote: calls the correct Finnhub URL", async () => {
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const mockData = { c: 150, d: 1.5, dp: 1.0, h: 152, l: 148, o: 149, pc: 148.5, t: 1234567890 };
  const { captured, restore } = stubFetch(mockData);
  try {
    const result = await getQuote("AAPL");
    assertEquals(captured.url, `${BASE}/quote?symbol=AAPL`);
    assertEquals(result, mockData);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// getCandles
// ---------------------------------------------------------------------------

Deno.test("getCandles: calls the correct Finnhub URL with from/to/resolution", async () => {
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const mockData = { c: [100, 101], t: [1000, 2000], s: "ok", h: [], l: [], o: [], v: [] };
  const { captured, restore } = stubFetch(mockData);
  try {
    const result = await getCandles("AAPL", 1000, 2000);
    assertEquals(
      captured.url,
      `${BASE}/stock/candle?symbol=AAPL&resolution=D&from=1000&to=2000`
    );
    assertEquals(result, mockData);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// getCompanyNews
// ---------------------------------------------------------------------------

Deno.test("getCompanyNews: calls the correct Finnhub URL with date params", async () => {
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const mockData = [
    {
      id: 1,
      headline: "Test",
      source: "Reuters",
      datetime: 1234567890,
      summary: "Summary",
      url: "https://example.com",
      image: "",
      category: "company",
      related: "AAPL",
    },
  ];
  const { captured, restore } = stubFetch(mockData);
  try {
    const result = await getCompanyNews("AAPL", "2024-01-01", "2024-01-31");
    assertEquals(
      captured.url,
      `${BASE}/company-news?symbol=AAPL&from=2024-01-01&to=2024-01-31`
    );
    assertEquals(result, mockData);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

Deno.test("finnhubFetch: throws when Finnhub returns a non-OK status", async () => {
  Deno.env.set("FINNHUB_API_KEY", API_KEY);
  const { restore } = stubFetch({ error: "Forbidden" }, 403);
  let threw = false;
  try {
    await getQuote("AAPL");
  } catch (err) {
    threw = true;
    assertEquals((err as Error).message.includes("403"), true);
  } finally {
    restore();
  }
  assertEquals(threw, true);
});
