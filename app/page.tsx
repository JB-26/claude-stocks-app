import SearchBar from "@/components/search/SearchBar";
import Footer from "@/components/layout/Footer";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <main className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="flex w-full max-w-2xl flex-col items-center gap-5">
          <SearchBar />
          <h1 className="text-2xl font-medium tracking-tight text-zinc-400">
            Claude Stocks App
          </h1>
        </div>
      </main>
      <Footer />
    </div>
  );
}
