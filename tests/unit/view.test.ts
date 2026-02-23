import { assertEquals } from "jsr:@std/assert";
import { parseDashboardParams } from "../../lib/view.ts";

Deno.test("parseDashboardParams: default view when view param absent", () => {
  const result = parseDashboardParams({ symbol: "AAPL" });
  assertEquals(result.view, "default");
  assertEquals(result.symbol2, null);
  assertEquals(result.symbol3, null);
});

Deno.test("parseDashboardParams: split view with symbol2", () => {
  const result = parseDashboardParams({ symbol: "AAPL", view: "split", symbol2: "tsla" });
  assertEquals(result.view, "split");
  assertEquals(result.symbol2, "TSLA"); // uppercased
});

Deno.test("parseDashboardParams: multi view with symbol2 and symbol3", () => {
  const result = parseDashboardParams({
    symbol: "AAPL",
    view: "multi",
    symbol2: "TSLA",
    symbol3: "msft",
  });
  assertEquals(result.view, "multi");
  assertEquals(result.symbol2, "TSLA");
  assertEquals(result.symbol3, "MSFT"); // uppercased
});

Deno.test("parseDashboardParams: unknown view value falls back to default", () => {
  const result = parseDashboardParams({ symbol: "AAPL", view: "quad" });
  assertEquals(result.view, "default");
});

Deno.test("parseDashboardParams: ignores symbol2 when view is default", () => {
  // Even if symbol2 is present in the URL, the parser still returns it —
  // the page simply does not use it when view === "default"
  const result = parseDashboardParams({ symbol: "AAPL", symbol2: "TSLA" });
  assertEquals(result.view, "default");
  assertEquals(result.symbol2, "TSLA"); // parsed but not rendered
});
