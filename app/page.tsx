import SearchBar from "@/components/search/SearchBar";
import RecentlyViewedChips from "@/components/search/RecentlyViewedChips";
import Footer from "@/components/layout/Footer";
import { isMarketOpen, getNextMarketOpenLabel } from "@/lib/utils";

export default function Home() {
  const marketOpen = isMarketOpen();

  return (
    <div className="flex min-h-screen flex-col">
      <main className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="flex w-full max-w-2xl flex-col items-center gap-5">
          {/* Market Status Bar */}
          <div className="flex items-center gap-2 text-xs tracking-wide">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                marketOpen ? "bg-green-400" : "bg-zinc-500"
              }`}
              aria-hidden="true"
            />
            {marketOpen ? (
              <span className="text-zinc-400">US Markets Open</span>
            ) : (
              <span className="text-zinc-500">
                US Markets Closed — Opens{" "}
                <span className="text-zinc-400">
                  {getNextMarketOpenLabel()}
                </span>
              </span>
            )}
          </div>

          <h1 className="text-center text-2xl font-medium tracking-tight text-zinc-200">
            Track any stock, instantly.
          </h1>

          <SearchBar />

          <RecentlyViewedChips />
        </div>
      </main>
      <Footer />
    </div>
  );
}
