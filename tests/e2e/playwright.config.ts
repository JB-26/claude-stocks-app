import { defineConfig, devices } from "@playwright/test";
import process from "node:process";

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
    // process.cwd() is the repo root when invoked via `deno task test:e2e`
    cwd: process.cwd(),
  },
});
