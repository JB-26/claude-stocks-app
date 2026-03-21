import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Claude Stocks App",
  description: "Professional stock market dashboard — search companies and track live prices, charts, and news.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${dmSans.variable} dark`}>
      <body className="font-sans antialiased">
        {/*
          * inset-x-0 (left:0; right:0) is preferred over w-full for fixed
          * headers. w-full resolves to 100% of viewport width which can
          * recalculate momentarily when a scrollbar appears/disappears.
          * inset-x-0 pins both edges to the viewport and is unaffected by
          * scrollbar-gutter changes, eliminating any residual lateral shift.
          */}
        <header className="fixed inset-x-0 top-0 z-50 border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur-sm">
          <div className="mx-auto flex h-10 max-w-7xl items-center px-6">
            <span className="text-sm font-semibold tracking-tight text-zinc-500">
              Claude Stocks
            </span>
          </div>
        </header>
        <div className="pt-10">{children}</div>
      </body>
    </html>
  );
}
