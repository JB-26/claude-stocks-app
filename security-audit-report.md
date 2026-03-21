# Security Audit Report

**Date**: 2026-03-21
**Audited By**: security-auditor agent
**Scope**: Full codebase review — all API route handlers, server-side library files, client components, configuration, and dependency manifest
**OWASP Reference**: OWASP Top 10:2025
**Risk Summary**: 🔴 0 High | 🟡 0 Medium | 🟢 4 Low (all fixed in this session) | ℹ️ 4 Info

---

## Executive Summary

The Claude Stocks App presents a strong security posture for a public-facing stock dashboard. All previously identified High and Medium findings from the February 2026 audit have been resolved and remain fixed. This session identified and remediated four residual Low-severity hardening gaps: URL scheme restriction in `sanitizeUrl`, logo URL validation in the profile route, IP extraction ordering in the rate limiter, and missing HSTS and explicit CSP directives in `next.config.ts`. No new exploitable vulnerabilities were found. The application's core controls — server-only API key isolation, strict input validation on every route, rate limiting with `Retry-After`, structured error messages, and a comprehensive CSP — are all operating correctly.

---

## OWASP Top 10:2025 Systematic Checklist

| Category | Status | Notes |
|---|---|---|
| A01 Broken Access Control | PASS | No auth required by design; no IDOR surface; API routes are all read-only public data |
| A02 Security Misconfiguration | FIXED | HSTS added; `connect-src` and `font-src` made explicit in CSP |
| A03 Software Supply Chain Failures | INFO | No automated SCA tooling; manual review shows no obviously vulnerable pinned versions |
| A04 Cryptographic Failures | PASS | No sensitive data stored; API key in env, never transmitted to client |
| A05 Injection | PASS | All symbol/query params validated by regex or allowlist before use; `encodeURIComponent` used on all upstream calls |
| A06 Insecure Design | PASS | Threat model is appropriate; all external calls proxied server-side |
| A07 Authentication Failures | N/A | No authentication in scope; by design (public dashboard) |
| A08 Software/Data Integrity Failures | FIXED | Logo URL from external API now validated via `sanitizeUrl` before caching |
| A09 Security Logging and Alerting Failures | INFO | Structured `console.error` logging present; no centralised alerting or anomaly detection |
| A10 Mishandling of Exceptional Conditions | PASS | All route handlers have try/catch; production error responses are stripped of internals |

---

## Findings

### 🟢 Finding 1 — `sanitizeUrl` Allowed HTTP URLs — OWASP A02 / CWE-319

**Severity**: 🟢 Low
**OWASP Category**: A02 — Security Misconfiguration / CWE-319: Cleartext Transmission of Sensitive Information
**Affected Area**: `lib/sanitize-url.ts` (line 9, prior to fix)
**Status**: FIXED in this session

**Description**:
`sanitizeUrl` previously accepted both `http:` and `https:` URLs. Any `http:` URL returned by the Finnhub news or profile APIs would pass validation and be sent to the browser. This would cause a mixed-content warning, potentially allow news article links to load over plaintext, and undermine the CSP `upgrade-insecure-requests` directive for those specific anchors.

**Evidence (before fix)**:
```typescript
if (parsed.protocol === "https:" || parsed.protocol === "http:") {
  return raw;
}
```

**Fix applied**:
```typescript
if (parsed.protocol === "https:") {
  return raw;
}
```

The function now rejects any URL that is not `https:`, returning `null`. The news route already uses `flatMap` to drop `null` articles, and the profile route falls back to `""` so `CompanyLogo` renders nothing.

**References**:
- OWASP Transport Layer Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html

---

### 🟢 Finding 2 — Profile Route Did Not Validate Logo URL from External API — OWASP A08 / CWE-601

**Severity**: 🟢 Low
**OWASP Category**: A08 — Software/Data Integrity Failures / CWE-601: URL Redirection to Untrusted Site
**Affected Area**: `app/api/stock/profile/route.ts` (line 37, prior to fix)
**Status**: FIXED in this session

**Description**:
The `/api/stock/profile` route passed `raw.logo` from the Finnhub API response directly into the cached `ProfileResponse` without URL validation. While the CSP `img-src` allowlist provides a browser-side defence, a Finnhub API response carrying a logo with a `data:`, `javascript:`, or unexpected `http:` scheme would have been cached server-side and forwarded to every client for the next hour. This is a defence-in-depth gap: external API responses should always be validated before caching, independently of client-side mitigations.

**Evidence (before fix)**:
```typescript
const response: ProfileResponse = {
  logo: raw.logo ?? "",
  name: raw.name ?? "",
};
```

**Fix applied**:
```typescript
import { sanitizeUrl } from "@/lib/sanitize-url";

const response: ProfileResponse = {
  logo: sanitizeUrl(raw.logo ?? "") ?? "",
  name: raw.name ?? "",
};
```

**References**:
- OWASP Input Validation Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html

---

### 🟢 Finding 3 — Rate Limiter Trusted Client-Controlled X-Forwarded-For — OWASP A01 / CWE-348

**Severity**: 🟢 Low
**OWASP Category**: A01 — Broken Access Control / CWE-348: Use of Less Trusted Source
**Affected Area**: `lib/ratelimit.ts` (line 21, prior to fix)
**Status**: FIXED in this session

**Description**:
The rate limiter extracted the IP address using `split(",")[0]` — the first (leftmost) value in the `X-Forwarded-For` header. The `X-Forwarded-For` header is a comma-separated list of IPs appended at each hop. The leftmost entry is supplied by the originating client and is trivially spoofable: a client could send `X-Forwarded-For: 1.2.3.4` and bypass rate limiting entirely by cycling through values. A trusted reverse proxy appends the real connecting IP at the rightmost position; that is the value that cannot be forged.

**Evidence (before fix)**:
```typescript
const ip =
  request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
```

**Fix applied**:
```typescript
const xff = request.headers.get("x-forwarded-for");
const ip = xff ? (xff.split(",").at(-1)?.trim() ?? "unknown") : "unknown";
```

**Note on deployment context**: This fix is correct when the app sits behind exactly one trusted proxy (e.g., Vercel's edge layer, a single Nginx instance). If there is a chain of N trusted proxies, the correct IP is at position `-(N)` from the right. The current change is appropriate for the expected Vercel deployment topology.

**References**:
- OWASP Testing for HTTP Header Injection: https://owasp.org/www-project-web-security-testing-guide/

---

### 🟢 Finding 4 — Missing HSTS Header and Implicit CSP Directives — OWASP A02 / CWE-523

**Severity**: 🟢 Low
**OWASP Category**: A02 — Security Misconfiguration / CWE-523: Unprotected Transport of Credentials
**Affected Area**: `next.config.ts`
**Status**: FIXED in this session

**Description**:
Three related hardening gaps existed in `next.config.ts`:

1. **No `Strict-Transport-Security` header.** Without HSTS, a browser visiting the app over HTTP would not be instructed to upgrade to HTTPS on all future visits. This opens the first-visit window to a downgrade attack if the app is deployed over a mixed HTTP/HTTPS configuration.

2. **No explicit `connect-src` directive.** The CSP relied on `default-src 'self'` to restrict `fetch` and `XMLHttpRequest` calls. While this inheritance is correct, adding an explicit `connect-src 'self'` makes the intent unambiguous and prevents any future `default-src` change from inadvertently widening the fetch allowlist.

3. **`font-src 'self'` blocked Google Fonts descriptors.** The app uses `next/font/google` (DM Sans). Next.js self-hosts the font files at build time, but the font loader fetches font metric descriptors from `fonts.gstatic.com` at runtime. Without `https://fonts.gstatic.com` in `font-src`, this request would be blocked by the CSP in strict environments, causing font fallback.

**Fix applied** (`next.config.ts`):
```typescript
"connect-src 'self'",
"font-src 'self' https://fonts.gstatic.com",
// ...
{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
```

**References**:
- MDN Strict-Transport-Security: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security
- OWASP HTTP Security Response Headers Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html

---

## Informational Observations

### ℹ️ INFO 1 — No Automated Software Composition Analysis (SCA)

**Affected Area**: `package.json` / CI pipeline
**Risk**: Dependency vulnerabilities (OWASP A03 — Software Supply Chain Failures) go undetected until manual review.

The application depends on `next@16.1.6`, `react@19.2.3`, `chart.js@^4.4.0`, and `@playwright/test@^1.51.0`. No automated SCA tool is configured. This is not a code-level vulnerability but a process gap — a compromised or vulnerable transitive dependency would not be detected until the next manual audit.

**Recommendation**: Enable Dependabot alerts on the GitHub repository (`Settings > Security > Dependabot alerts`). Add `npm audit --audit-level=high` as a CI step. This costs nothing and provides continuous A03 coverage.

---

### ℹ️ INFO 2 — Rate Limiter Is In-Process (No Cross-Instance Sharing)

**Affected Area**: `lib/ratelimit.ts`
**Risk**: Under horizontal scaling, each server instance holds an independent rate-limit window map.

If the application is ever scaled to multiple Node/Deno processes, each instance maintains its own `ipWindows` map. A client could effectively multiply the rate limit by the number of instances. For the current single-instance deployment this is not exploitable.

**Recommendation**: If horizontal scaling becomes necessary, replace the in-process map with a shared store such as Upstash Redis (compatible with Vercel's edge runtime) and the `@upstash/ratelimit` library.

---

### ℹ️ INFO 3 — `'unsafe-inline'` in `script-src` and `style-src`

**Affected Area**: `next.config.ts` CSP
**Risk**: Reduced XSS protection depth — inline scripts and styles are permitted.

This is standard for current Next.js (App Router), which inlines script chunks for hydration and Tailwind generates inline styles. Removing `'unsafe-inline'` from `script-src` requires nonce-based CSP. No `dangerouslySetInnerHTML` usage was found anywhere in the codebase, which is the primary XSS vector this directive would otherwise enable.

**Recommendation**: Accepted trade-off for the current architecture. If requirements increase, implement nonce-based CSP via `middleware.ts`. See: https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy

---

### ℹ️ INFO 4 — `session.ts` `loadRecent` Lacks Symbol Validation on Read

**Affected Area**: `lib/session.ts`
**Risk**: Negligible — symbols are only ever used as query parameters to the app's own validated API routes.

`loadRecent()` parses `sessionStorage` without filtering for valid symbol format. By contrast, `lib/watchlist.ts` correctly filters with `SYMBOL_RE` on read. The practical risk is minimal because values only become `?symbol=` query parameters, which are re-validated server-side. However, for consistency and defence in depth, the same filter should apply.

**Recommendation**: Add a `SYMBOL_RE` filter in `loadRecent()`:
```typescript
export function loadRecent(): string[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === "string" && /^[A-Z]{1,10}$/.test(item)
    );
  } catch {
    return [];
  }
}
```

---

## Positive Security Controls Observed

The following controls are well-implemented and should be maintained:

- **API key isolation**: `FINNHUB_API_KEY` is accessed only in `lib/finnhub/client.ts`, guarded by `import "server-only"`. The key cannot leak to the client bundle.
- **Input validation on all routes**: Every route handler that accepts a `symbol` parameter validates it against `/^[A-Z]{1,10}$/` before use. The search route sanitises the free-text `q` param with a character allowlist regex.
- **Server-side API proxying**: All calls to Finnhub and Yahoo Finance originate from the server. No API keys or raw external URLs are ever exposed to the browser.
- **Structured error responses**: `lib/finnhub/client.ts` strips response body details in production — only the HTTP status and path are included. Client-facing 500 responses use generic messages.
- **Rate limiting with `Retry-After`**: All six API routes call `checkRateLimit` and include `Retry-After` in 429 responses. The `useRetryableFetch` hook respects this header.
- **Bounded in-memory caches**: `lib/cache.ts` enforces a 1,000-entry cap with FIFO eviction and a 5-minute sweep interval. `lib/ratelimit.ts` enforces a 10,000-entry IP window cap.
- **Comprehensive security headers**: CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and HSTS are all set on every route.
- **URL sanitisation on all external API data**: News article URLs and logo URLs are validated through `sanitizeUrl` before being cached or returned to clients.
- **`rel="noopener noreferrer"` on external links**: All news article anchors include both attributes, preventing tab-napping.
- **No `dangerouslySetInnerHTML` anywhere**: Confirmed by codebase-wide review. All content is rendered as React text nodes.
- **Watchlist input validation on read**: `lib/watchlist.ts` filters localStorage contents against `SYMBOL_RE` when reading, defending against corrupted or externally modified storage.
- **`.env.local` excluded from version control**: The `.env*.local` pattern is correctly in `.gitignore`; only `.env.example` with an empty placeholder is committed.

---

## Recommendations Summary

| Severity | Finding | OWASP Ref | File(s) | Status | Effort |
|---|---|---|---|---|---|
| 🟢 Low | `sanitizeUrl` allowed `http:` URLs | A02 | `lib/sanitize-url.ts` | Fixed | Trivial |
| 🟢 Low | Profile route logo URL not validated | A08 | `app/api/stock/profile/route.ts` | Fixed | Trivial |
| 🟢 Low | Rate limiter read first XFF entry (spoofable) | A01 | `lib/ratelimit.ts` | Fixed | Trivial |
| 🟢 Low | Missing HSTS; implicit `connect-src`/`font-src` | A02 | `next.config.ts` | Fixed | Trivial |
| ℹ️ Info | No automated SCA / Dependabot | A03 | `package.json` / CI | Open | Low |
| ℹ️ Info | In-process rate limiter not scalable | A01 | `lib/ratelimit.ts` | Accepted | Medium |
| ℹ️ Info | `unsafe-inline` in script-src / style-src | A02 | `next.config.ts` | Accepted | High |
| ℹ️ Info | `session.ts` loadRecent lacks symbol filter | — | `lib/session.ts` | Open | Trivial |
