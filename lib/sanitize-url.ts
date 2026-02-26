/**
 * Returns the URL string if it uses http: or https: protocol, otherwise null.
 * Protects against javascript:, data:, mailto:, and other dangerous protocols,
 * as well as relative paths and malformed URL strings.
 */
export function sanitizeUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}
