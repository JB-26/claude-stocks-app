// No-op stub for the `server-only` npm package.
// The real package throws unless the React Server Component bundler condition
// is active, which it isn't in a plain `deno test` context.
// This file is mapped via deno.json "imports" so the real package is never loaded.
export {};
