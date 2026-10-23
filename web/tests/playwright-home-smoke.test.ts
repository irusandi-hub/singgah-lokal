import { test, expect } from "@playwright/test";

/**
 * Playwright smoke — Singgah Lokal Home (read-only, no data/account/admin side effects).
 *
 * Each test opens BASE_URL explicitly before asserting anything, so nothing is
 * checked against a blank page. The checks never sign in, create accounts,
 * upload files, write data, or touch admin surfaces.
 *
 * The Home map is MANDATORY here. `components/home-map.tsx` renders its
 * container unconditionally as
 *   <div ref={containerRef} class="relative z-0 h-full w-full touch-none
 *        singgah-home-map" aria-label="Peta Tempat" />
 * inside Home's absolute inset-0 map stage, so a missing or collapsed container
 * is a real Home regression and must fail this smoke. Location permission and
 * tile completion are NOT required — only the container element itself.
 *
 * RUNNER GUARD: this file lives under `tests/`, which the project's unit suite
 * glob (see the `test` script in package.json) also walks. Node's test runner sets
 * NODE_TEST_CONTEXT in each test-file child process; when that is present this
 * module registers no Playwright tests, so the unit suite never tries to run a
 * browser spec. Under `playwright test` the variable is absent and the two
 * smoke tests below register normally.
 */

const underNodeTestRunner = (process.env.NODE_TEST_CONTEXT ?? "") !== "";

const base = process.env.BASE_URL ?? "";

if (!underNodeTestRunner) {
  if (base === "") {
    test.skip(true, "BASE_URL is not set; nothing to smoke against");
  }

  test.describe("qplaywright-home-smoke / Home smoke", () => {
    test("the target is reachable", async ({ page }) => {
      const response = await page.goto(base, { waitUntil: "domcontentloaded" });
      expect(response).toBeTruthy();
      expect(response?.status()).toBeLessThan(500);
    });

    test("Home renders the shell and the map container", async ({ page }) => {
      await page.goto(base, { waitUntil: "domcontentloaded" });

      // The Home root: `<main>` authored in components/home-discovery.tsx.
      await expect(page.locator("main").first()).toBeVisible({ timeout: 15000 });

      // The map container is required: HomeMap's own container element, matched
      // by its real class hook and accessible name. No fallback, no early return.
      const mapContainer = page.locator('div.singgah-home-map[aria-label="Peta Tempat"]').first();
      await expect(mapContainer).toBeVisible({ timeout: 15000 });

      // Visible alone is not enough: the container must actually occupy the map
      // stage. Tiles may still be loading, so only the element's box is checked.
      const box = await mapContainer.boundingBox();
      expect(box, "the Home map container must have a measurable box").not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
    });
  });
}
