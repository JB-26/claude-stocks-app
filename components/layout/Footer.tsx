export default function Footer() {
  return (
    <footer
      role="contentinfo"
      className="w-full border-t border-zinc-800 py-6 text-center text-xs text-zinc-600"
    >
      © {new Date().getFullYear()} Claude Stocks App. Quotes &amp; news by{" "}
      <span className="text-zinc-500">Finnhub</span>. Historical data by{" "}
      <span className="text-zinc-500">Yahoo Finance</span>.
    </footer>
  );
}
