import { defineConfig, devices } from "@playwright/test";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";

/**
 * Playwright config for the PR smoke only.
 *
 * `testMatch` keeps this run to the two Home smoke tests. The project's real
 * unit suite is run by `bun run test` (tsx --test over tests), not Playwright,
 * so this config needs no ignore list.
 */
export default defineConfig({
  testDir: "tests",
  testMatch: ["playwright-home-smoke.test.ts", "home-initial-camera.e2e.test.ts"],
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: baseUrl,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
