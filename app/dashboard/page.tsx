import { redirect } from "next/navigation";
import Link from "next/link";
import CompanySelector from "@/components/dashboard/CompanySelector";
import PriceHeader from "@/components/dashboard/PriceHeader";

interface Props {
  searchParams: Promise<{ symbol?: string }>;
}

export default async function DashboardPage({ searchParams }: Props) {
  const { symbol } = await searchParams;

  if (!symbol) {
    redirect("/");
  }

  const ticker = symbol.toUpperCase();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <Link
            href="/"
            className="text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-100"
          >
            ← Search
          </Link>
          <CompanySelector currentSymbol={ticker} />
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        <div className="mb-8">
          <p className="mb-2 text-sm font-medium uppercase tracking-widest text-zinc-500">
            {ticker}
          </p>
          <PriceHeader symbol={ticker} />
        </div>

        {/* StockChart — Task 11 */}
        {/* NewsFeed — Task 12 */}
      </main>
    </div>
  );
}
