import { defineConfig, devices } from "@playwright/test";

// Resolve the project root regardless of where Playwright is invoked from.
// import.meta.url points to tests/e2e/playwright.config.ts, so two levels up
// is the repo root where next.config.ts and the app/ directory live.
const projectRoot = new URL("../..", import.meta.url).pathname;

export default defineConfig({
  testDir: "./",
  testMatch: "**/*.spec.ts",
  use: {
    baseURL: "http://localhost:3000",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command:
      "deno run -A --unstable-bare-node-builtins --unstable-sloppy-imports npm:next dev",
    url: "http://localhost:3000",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    cwd: projectRoot,
  },
});
