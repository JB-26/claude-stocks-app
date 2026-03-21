import type { NextConfig } from "next";
import process from "node:process";

const isDev = process.env.NODE_ENV === "development";

const cspHeader = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // All external API calls are proxied server-side; the browser only ever
  // calls the app's own /api/* routes.
  "connect-src 'self'",
  "img-src 'self' data: https://static2.finnhub.io https://finnhub.io",
  // Google Fonts are loaded via next/font — fonts are self-hosted at build
  // time but the font loader fetches descriptors from fonts.gstatic.com.
  "font-src 'self' https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: cspHeader },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // HSTS: instruct browsers to always use HTTPS for this origin.
          // max-age=63072000 = 2 years (HSTS preload minimum).
          // includeSubDomains and preload are included for forward-compatibility;
          // remove them if subdomains are not all HTTPS-capable.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
    ];
  },
};

export default nextConfig;
