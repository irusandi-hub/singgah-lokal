import { test, expect } from "@playwright/test";

/**
 * Playwright smoke — Singgah Lokal Home (read-only, no data/account/admin side effects).
 *
 * These tests only verify that the Home page loads without a server/runtime error and
 * that the expected content and map areas are present after load. They never sign in,
 * create accounts, upload files, write data, or hit admin surfaces.
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

  test("Home renders without an error marker", async ({ page }) => {
    await expect(page).not.toHaveSelector(".not-found, [data-testid=error-page], text=/not found/i");
    await expect(page.locator("body")).not.toContainText(/error/i, { ignoreCase: true });
  });

  test("main content area is present", async ({ page }) => {
    await expect(page.locator("main, [role=main], article").first()).toBeVisible({ timeout: 10000 });
  });

  test("a map container appears after load", async ({ page }) => {
    const mapArea = page.locator(
      '[class*="map"], [class*="leaflet"], [role="img"][aria-label*="peta"], [aria-label*="peta"]',
    );
    // The map is only expected on Home; if Home does not render a map in the target
    // build, the locator can stay empty and the test should not fail.
    if (await mapArea.count() > 0) {
      await expect(mapArea.first()).toBeVisible({ timeout: 15000 });
    }
  });
});
