import { redirect } from "next/navigation";
import Link from "next/link";
import CompanySelector from "@/components/dashboard/CompanySelector";
import ViewSelector from "@/components/dashboard/ViewSelector";
import CompanyPanel from "@/components/dashboard/CompanyPanel";
import PlaceholderPanel from "@/components/dashboard/PlaceholderPanel";
import { parseDashboardParams } from "@/lib/view";

interface Props {
  searchParams: Promise<{
    symbol?: string;
    view?: string;
    symbol2?: string;
    symbol3?: string;
  }>;
}

export default async function DashboardPage({ searchParams }: Props) {
  const rawParams = await searchParams;

  if (!rawParams.symbol) {
    redirect("/");
  }

  const { symbol: ticker, view, symbol2, symbol3 } = parseDashboardParams(rawParams);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <Link
            href="/"
            className="text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-100"
          >
            &larr; Search
          </Link>
          <div className="flex items-center gap-2">
            <CompanySelector currentSymbol={ticker} />
            <ViewSelector currentSymbol={ticker} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1">
        {view === "default" && <CompanyPanel symbol={ticker} />}

        {view === "split" && (
          <div className="grid grid-cols-1 divide-y divide-zinc-800 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <CompanyPanel symbol={ticker} compact showNews={false} />
            {symbol2 ? (
              <CompanyPanel symbol={symbol2} compact showNews={false} />
            ) : (
              <PlaceholderPanel />
            )}
          </div>
        )}

        {view === "multi" && (
          <>
            <div className="grid grid-cols-1 divide-y divide-zinc-800 border-b border-zinc-800 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
              <CompanyPanel symbol={ticker} compact showNews={false} />
              {symbol2 ? (
                <CompanyPanel symbol={symbol2} compact showNews={false} />
              ) : (
                <PlaceholderPanel />
              )}
            </div>
            <div>
              {symbol3 ? (
                <CompanyPanel symbol={symbol3} />
              ) : (
                <PlaceholderPanel />
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
