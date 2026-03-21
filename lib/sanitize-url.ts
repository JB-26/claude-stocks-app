/**
 * Returns the URL string if it uses the https: protocol, otherwise null.
 * Restricting to https: only prevents mixed-content issues and eliminates
 * the residual risk of http: URLs being delivered to the browser over a
 * plaintext channel.
 * Protects against javascript:, data:, mailto:, http:, and other dangerous
 * protocols, as well as relative paths and malformed URL strings.
 */
export function sanitizeUrl(raw: string): string | null {
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
