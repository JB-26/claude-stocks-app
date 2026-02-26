# Security Audit Report

**Date**: 2026-02-26
**Audited By**: security-auditor agent
**Scope**: Re-audit of previously identified High and Medium findings. Files reviewed: `next.config.ts`, `app/api/stock/news/route.ts`, `lib/finnhub/client.ts`, `lib/cache.ts`, `lib/ratelimit.ts` (new), `app/api/stock/search/route.ts`, `app/api/stock/quote/route.ts`, `app/api/stock/candles/route.ts`, `app/api/stock/profile/route.ts`, `components/dashboard/CompanyLogo.tsx`.
**Risk Summary**: 🔴 0 High | 🟡 2 Medium | 🟢 3 Low | ℹ️ 2 Info

---

## Executive Summary

All five previously identified High and Medium findings have been resolved. The codebase now ships HTTP security headers, rate limiting on every API route, URL sanitisation for news article links, a bounded in-memory cache with periodic sweep, and scoped error messages in server logs. No new High-severity issues were introduced by the fixes. Two new Medium findings were identified: the rate limiter's IP extraction blindly trusts the `X-Forwarded-For` header, allowing attackers on certain deployment topologies to spoof their IP address and bypass throttling; and 429 responses do not include a `Retry-After` header, making the rate limiter harder to consume correctly. Three minor Low findings and two informational observations round out the report.

---

## Previous Findings — Resolution Status

| Finding | Previous Severity | Status |
|---------|------------------|--------|
| No HTTP security headers in `next.config.ts` | 🔴 High | Resolved |
| Unvalidated external URLs in news feed | 🟡 Medium | Resolved |
| Verbose server error messages in `lib/finnhub/client.ts` | 🟡 Medium | Resolved |
| In-memory cache has no upper bound | 🟡 Medium | Resolved |
| No rate limiting on API proxy routes | 🟡 Medium | Resolved |

---

## Findings

### 🟡 Finding 1 — Rate Limiter Trusts `X-Forwarded-For` Without Proxy Validation

**Severity**: 🟡 Medium
**OWASP Category**: A05 — Security Misconfiguration
**Affected Area**: `lib/ratelimit.ts` (line 12)

**Description**:
The rate limiter keys each window on the client IP extracted from the `X-Forwarded-For` request header. The `X-Forwarded-For` header is set by proxies and load balancers to record the originating client IP, but it is also freely settable by any HTTP client. If the application is deployed in a context where requests can reach the Next.js process directly (not behind a trusted reverse proxy), an attacker can set `X-Forwarded-For: <arbitrary IP>` and cycle through different fake IPs to bypass the per-IP rate limit entirely.

The concrete attack is straightforward: a script that rotates the `X-Forwarded-For` value on each request can issue unlimited calls to any `/api/stock/` route, exhausting the Finnhub free-tier quota (60 requests/minute) and causing a denial of service for all other users.

The severity is Medium rather than High because: (a) many common deployment targets for Next.js — Vercel, Railway, Render — sit behind infrastructure that either strips or canonicalises this header before it reaches application code, partially mitigating the risk; and (b) the rate limiter still provides meaningful protection in correctly-proxied deployments.

**Evidence**:
```typescript
// lib/ratelimit.ts — lines 11–14
const ip =
  request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
const pathname = new URL(request.url).pathname;
const key = `${ip}:${pathname}`;
```

When `X-Forwarded-For: 1.2.3.4` is included in any request, the rate limiter keys the window on `1.2.3.4` without verifying that this header was set by a trusted upstream proxy.

**Recommendation**:
1. **Preferred — use a platform-provided IP.** If deploying to Vercel, use the `x-real-ip` header which Vercel sets to the verified client IP and which cannot be spoofed by the client. For other platforms, consult their documentation for the equivalent trusted header.

2. **Alternative — validate `X-Forwarded-For` depth.** If you control the proxy chain and know that exactly one hop precedes the app server, take the *last* value in the comma-separated `X-Forwarded-For` list rather than the first. The last value is the one appended by your trusted proxy and cannot be forged by the client:
   ```typescript
   const forwardedFor = request.headers.get("x-forwarded-for") ?? "";
   const parts = forwardedFor.split(",").map((s) => s.trim()).filter(Boolean);
   // Last entry is set by the nearest trusted proxy — cannot be spoofed by client
   const ip = parts[parts.length - 1] ?? "unknown";
   ```

3. **Fallback.** If deployment context is uncertain, document the IP extraction strategy and the assumption it encodes (trusted proxy present) as a comment in `lib/ratelimit.ts`.

**References**:
- OWASP ASVS V13.4.1 — API Protection
- CWE-348 (Use of Less Trusted Source for IP Address)

---

### 🟡 Finding 2 — 429 Responses Do Not Include a `Retry-After` Header

**Severity**: 🟡 Medium
**OWASP Category**: A05 — Security Misconfiguration
**Affected Area**: All five route handlers (`app/api/stock/search/route.ts`, `app/api/stock/quote/route.ts`, `app/api/stock/candles/route.ts`, `app/api/stock/news/route.ts`, `app/api/stock/profile/route.ts`)

**Description**:
When a request is rate-limited, all five route handlers return a `429 Too Many Requests` response body with `{ error: "Too many requests" }` but no `Retry-After` header. RFC 6585 defines `Retry-After` as the standard way for a server to indicate when the client may retry. Without it:

- The application's own fetch calls in client components (e.g. `SearchBar.tsx`, `CompanyLogo.tsx`) receive a 429 and have no information about when to retry. Currently they swallow the error silently, but any future retry logic would be forced to use an arbitrary backoff interval.
- Automated clients and monitoring tools cannot distinguish a transient rate limit from a hard service failure.
- The missing header is flagged by API security scanners and compliance tooling as a misconfiguration.

**Evidence**:
```typescript
// app/api/stock/news/route.ts — lines 28–30
if (!checkRateLimit(request)) {
  return NextResponse.json({ error: "Too many requests" }, { status: 429 });
}
```

The rate limiter stores `resetAt` for each IP window (in `lib/ratelimit.ts` line 22) but this value is not returned to the caller, making it impossible to compute `Retry-After` at the route handler level without refactoring `checkRateLimit`.

**Recommendation**:
Refactor `checkRateLimit` to return either `true` or a `{ allowed: false; retryAfterMs: number }` object so callers can include a `Retry-After` header:

```typescript
// lib/ratelimit.ts — revised return type
export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export function checkRateLimit(request: Request): RateLimitResult {
  // ... existing logic ...
  if (window.count >= MAX_REQUESTS) {
    return { allowed: false, retryAfterMs: window.resetAt - now };
  }
  // ...
  return { allowed: true };
}

// In each route handler:
const rl = checkRateLimit(request);
if (!rl.allowed) {
  return NextResponse.json(
    { error: "Too many requests" },
    {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
    }
  );
}
```

**References**:
- RFC 6585, Section 4 — 429 Too Many Requests
- OWASP ASVS V13.4 — API Protection

---

### 🟢 Finding 3 — CSP Missing `Strict-Transport-Security` (HSTS) Header

**Severity**: 🟢 Low
**OWASP Category**: A05 — Security Misconfiguration
**Affected Area**: `next.config.ts` (lines 19–34)

**Description**:
The `headers()` function in `next.config.ts` correctly sets `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`. However, it does not include a `Strict-Transport-Security` (HSTS) header.

Without HSTS, a browser that visits the application over HTTP before it is redirected to HTTPS will not be instructed to always use HTTPS for future visits to the same origin. This creates a window for SSL stripping attacks: a network-level attacker can intercept the initial HTTP request before the redirect occurs and serve a plain-HTTP version of the application. For a stock dashboard that could inform financial decisions, confidentiality of the data in transit is relevant.

This is Low rather than Medium because most modern hosting platforms (Vercel, Cloudflare, etc.) enforce HTTPS redirects at the infrastructure level and may also inject HSTS headers automatically. The risk is primarily relevant if the application is self-hosted without a reverse proxy.

**Evidence**:
```typescript
// next.config.ts — headers array (lines 24–30)
headers: [
  { key: "Content-Security-Policy", value: cspHeader },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Strict-Transport-Security is absent
],
```

**Recommendation**:
Add the `Strict-Transport-Security` header to the existing `headers` array:

```typescript
{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
```

Note: do not add `preload` to the HSTS value unless you have registered the domain with the HSTS preload list (https://hstspreload.org), as doing so is difficult to reverse. A `max-age` of 63072000 (two years) is the industry standard recommendation.

**References**:
- OWASP ASVS V9.2.1 — Transport Layer Security
- MDN: Strict-Transport-Security

---

### 🟢 Finding 4 — News `sanitizeUrl` Permits `http:` URLs — Residual Plain-HTTP Content

**Severity**: 🟢 Low
**OWASP Category**: A02 — Cryptographic Failures
**Affected Area**: `app/api/stock/news/route.ts` (lines 11–21)

**Description**:
The `sanitizeUrl` function correctly rejects non-HTTP schemes such as `javascript:` and `data:`, which resolves the original finding. However, it also explicitly permits `http:` (unencrypted) URLs alongside `https:`:

```typescript
// app/api/stock/news/route.ts — lines 13–16
const parsed = new URL(raw);
if (parsed.protocol === "https:" || parsed.protocol === "http:") {
  return raw;
}
```

An `http:` news article URL would be sent to the browser as a link. When a user clicks it, their browser sends an unencrypted request, potentially exposing the user's browsing activity and the destination site's content to a network observer. The CSP directive `upgrade-insecure-requests` is present in `next.config.ts` and would cause the browser to upgrade such links to HTTPS automatically — this significantly reduces the practical risk. However, `upgrade-insecure-requests` is a best-effort browser instruction and is not a substitute for server-side enforcement.

**Evidence**:
```typescript
// app/api/stock/news/route.ts — line 14
if (parsed.protocol === "https:" || parsed.protocol === "http:") {
  return raw;
}
```

**Recommendation**:
Restrict `sanitizeUrl` to `https:` only, and drop `http:` URLs rather than passing them through:

```typescript
function sanitizeUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:") {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}
```

In practice, all reputable financial news sources (Reuters, CNBC, Bloomberg) serve over HTTPS. Any `http:` URL from Finnhub's news feed would indicate either a very old article or a data quality issue — dropping it is the safer choice.

**References**:
- OWASP ASVS V9.1.1 — Transport Layer Security for Client Communications

---

### 🟢 Finding 5 — Company Logo URL Not Validated Before Rendering

**Severity**: 🟢 Low
**OWASP Category**: A05 — Security Misconfiguration
**Affected Area**: `app/api/stock/profile/route.ts` (line 32), `components/dashboard/CompanyLogo.tsx` (line 36)

**Description**:
This finding carries over from the previous audit as unresolved. The `/api/stock/profile` route passes the `logo` field from Finnhub's API response directly into the `ProfileResponse` without validating that it is an `https://` URL:

```typescript
// app/api/stock/profile/route.ts — lines 31–33
const response: ProfileResponse = {
  logo: raw.logo ?? "",
  name: raw.name ?? "",
};
```

`CompanyLogo.tsx` then sets this URL as the `src` of a plain `<img>` tag. This means the browser will load an image from any URL Finnhub returns. The `img-src` CSP directive in `next.config.ts` now restricts image loading to `'self' data: https://static2.finnhub.io https://finnhub.io`, which provides meaningful browser-side protection. However, the logo URL is also cached server-side for one hour — a non-HTTPS or non-Finnhub logo URL would be stored in the cache and served to all users for that hour before expiry.

The severity is Low (not Medium) because the CSP `img-src` whitelist is an effective browser-side control, and Finnhub's logo field is consistently an `https://static2.finnhub.io/...` URL in practice. The residual concern is defence-in-depth: server-side validation would provide a second layer independent of browser enforcement.

**Evidence**:
```typescript
// app/api/stock/profile/route.ts — line 32
logo: raw.logo ?? "",  // no URL validation

// components/dashboard/CompanyLogo.tsx — line 36
src={logoUrl}  // plain <img> tag, not next/image
```

**Recommendation**:
Add URL validation in the profile route handler, mirroring the pattern already used in the news route:

```typescript
// app/api/stock/profile/route.ts
const ALLOWED_LOGO_HOSTS = ["static2.finnhub.io", "finnhub.io"];

function sanitizeLogoUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" && ALLOWED_LOGO_HOSTS.includes(parsed.hostname)) {
      return raw;
    }
  } catch {
    // fall through
  }
  return "";
}

const response: ProfileResponse = {
  logo: sanitizeLogoUrl(raw.logo ?? ""),
  name: raw.name ?? "",
};
```

**References**:
- OWASP ASVS V5.2 — Input Sanitization and Validation
- Previous audit Finding 7 (2026-02-25)

---

### ℹ️ Info 1 — Rate Limiter FIFO Eviction May Allow Window Reset Under Cache Pressure

**Severity**: ℹ️ Info
**Affected Area**: `lib/ratelimit.ts` (lines 19–22)

**Description**:
When the `ipWindows` Map reaches `MAX_IP_ENTRIES` (10,000), the rate limiter evicts the oldest entry using FIFO (`store.keys().next().value`). This is the same eviction strategy used in `lib/cache.ts`.

An adversary who controls many IP addresses (or can spoof `X-Forwarded-For` — see Finding 1) could, in theory, fill the 10,000-entry table with dummy keys to cause their own real entry to be evicted, resetting their request count. This is a realistic concern only when combined with Finding 1 (IP spoofing), which is the more direct attack vector. With a trustworthy IP source, FIFO eviction of legitimate IPs is harmless because the evicted entry's window would be recreated on the next request with a fresh count of 1.

This is recorded as informational because the attack is only viable if Finding 1 is also exploitable in the deployment environment.

**Recommendation**:
Address Finding 1 first. If Finding 1 is addressed by using a platform-verified IP, this observation has no practical impact and can be accepted.

---

### ℹ️ Info 2 — CSP `connect-src` Directive Not Explicit

**Severity**: ℹ️ Info
**Affected Area**: `next.config.ts` (lines 6–17)

**Description**:
The Content Security Policy does not include an explicit `connect-src` directive. `connect-src` governs which URLs can be loaded via `fetch()`, `XMLHttpRequest`, and WebSocket from client-side JavaScript. Without an explicit value, `connect-src` inherits from `default-src 'self'`, which is the correct and restrictive default for this application — all client-side `fetch()` calls target the same origin (`/api/stock/...`).

This is informational only and does not represent a gap, but making `connect-src` explicit documents the intent clearly and would prevent a future developer from inadvertently relaxing `default-src` and unknowingly widening the `connect-src` scope.

**Recommendation**:
Consider adding `"connect-src 'self'"` explicitly to the CSP array to document intent:

```typescript
"connect-src 'self'",
```

---

## Positive Security Controls Observed

The following controls from the previous audit remain in place and have been supplemented by the fixes:

1. **HTTP security headers are now fully configured.** `next.config.ts` correctly sets CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and `Permissions-Policy` on all routes. The CSP correctly uses `isDev` to add `'unsafe-eval'` only in development.

2. **Rate limiting is applied to all five API routes.** Every route handler calls `checkRateLimit(request)` as its first operation, before parameter validation and before any cache or upstream access. The limit (30 req/IP/route/minute) and the per-Map size cap (10,000 entries) are appropriate for a free-tier dashboard.

3. **News article URL sanitisation is implemented correctly.** `sanitizeUrl()` uses the `URL` constructor for robust parsing (not string prefix matching) and rejects all non-HTTP schemes. Articles with unsafe `url` fields are dropped from the response entirely via `flatMap` — not given a fallback value.

4. **Server error messages no longer leak upstream URLs or response bodies in production.** `lib/finnhub/client.ts` now uses `new URL(url).pathname` (stripping the query string that could contain symbol data) and only appends the response body in `NODE_ENV === "development"`.

5. **In-memory cache is now bounded.** `lib/cache.ts` enforces `MAX_ENTRIES = 1000` with FIFO eviction and runs a proactive `setInterval` sweep every 5 minutes to remove expired entries without waiting for a read.

6. **All previously confirmed controls remain intact.** `server-only` guards on `lib/finnhub/client.ts` and `lib/yahoo.ts`, `encodeURIComponent` on all upstream query parameters, `SYMBOL_RE` validation on all symbol-accepting routes, and the absence of `dangerouslySetInnerHTML` throughout the codebase.

---

## Recommendations Summary

| Severity | Finding | OWASP Ref | Effort |
|----------|---------|-----------|--------|
| 🟡 Medium | Rate limiter trusts spoofable `X-Forwarded-For` header | A05 | Low |
| 🟡 Medium | 429 responses missing `Retry-After` header | A05 | Low |
| 🟢 Low | Add `Strict-Transport-Security` header to `next.config.ts` | A05 | Low |
| 🟢 Low | Restrict `sanitizeUrl` in news route to `https:` only | A02 | Low |
| 🟢 Low | Validate logo URL in profile route before caching and returning | A05 | Low |
| ℹ️ Info | Rate limiter FIFO eviction exploitable only when combined with IP spoofing | — | None (accept after fixing Finding 1) |
| ℹ️ Info | Add explicit `connect-src 'self'` to CSP for clarity | — | Trivial |

---

*Report generated by security-auditor agent on 2026-02-26. All file references use paths relative to the repository root at `/Users/joshuablewitt/Repos/claude stocks app/`.*
