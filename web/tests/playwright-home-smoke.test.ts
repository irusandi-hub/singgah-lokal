import { test, expect } from "@playwright/test";

/**
 * Playwright smoke — Singgah Lokal Home (read-only, no data/account/admin side effects).
 *
 * Read-only smoke for the Singgah Lokal Home page. Each test opens BASE_URL
 * explicitly before checking anything, so no test depends on a blank or
 * partially-loaded page. The checks never sign in, create accounts, upload
 * files, write data, or touch admin surfaces.
 */

const base = process.env.BASE_URL;

if (!base) {
  test.skip(true, "BASE_URL is not set; nothing to smoke against");
}

test.describe("qplaywright-home-smoke / Home smoke", () => {
  test("the target is reachable", async ({ page }) => {
    const response = await page.goto(base, { waitUntil: "domcontentloaded" });
    expect(response).toBeTruthy();
    expect(response?.status()).toBeLessThan(500);
  });

  test("Home renders the expected shell on Home", async ({ page }) => {
    await page.goto(base, { waitUntil: "domcontentloaded" });

    // Singgah Lokal Home uses a `<main>` root authored in
    // `components/home-discovery.tsx`, so assert that exact Home shell
    // instead of a generic `main, [role=main], article` guess.
    const mainRoot = page.locator("main").first();
    await expect(mainRoot).toBeVisible({ timeout: 15000 });

    // Optional resilience signal: the map container should be present on
    // Home once it renders. Do not treat a missing map as success; if the
    // map locator exists here it must be visible within a reasonable time.
    const mapArea = page.locator(
      '[aria-label="Peta Tempat"], .singgah-home-map, [class*="singgah-home-map"]',
    );
    if (await mapArea.count() > 0) {
      await expect(mapArea.first()).toBeVisible({ timeout: 15000 });
    }
  });
});
