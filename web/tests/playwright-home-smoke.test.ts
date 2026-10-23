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

    /**
     * INITIAL-FRAME CONSISTENCY (regression, 2026-10-23).
     *
     * BUG THIS LOCKS SHUT: with no location permission the map opened on
     * `fitWorld()`, which `minZoom: 2` clamped to a ~137° slice centred on
     * [0, 0] covering only the Gulf. The first viewport report then narrowed
     * the rows and markers to that slice, so the catalogue silently dropped
     * every Indonesian Place while the map looked global.
     *
     * The properties asserted here, with geolocation NOT granted:
     *   · the map and the list agree (one Place = one pin);
     *   · the first reported frame does not remove Places the server rendered;
     *   · nothing collapses later (no world-slice re-frame after settle).
     */
    test("Home keeps the whole catalogue on the map before any location fix", async ({ browser }) => {
      // MOBILE viewport on purpose: the regression only exists when the map is
      // narrower than the world at `minZoom: 2`. A desktop-width container fits
      // the whole world and would hide the bug.
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      await page.goto(base, { waitUntil: "domcontentloaded" });

      // Sample the row count from the very first paint until the map has
      // reported and settled. The bug this guards against is a SHRINK: the
      // server-rendered catalogue was rendered, then the first viewport report
      // removed every Place outside a clamped world slice.
      const samples: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        samples.push(await page.locator("[data-place-card-id]").count());
        await page.waitForTimeout(150);
      }

      const widest = Math.max(...samples);
      const settled = samples[samples.length - 1];
      expect(widest, "Home must render its catalogue before the map reports").toBeGreaterThan(0);
      expect(settled, "the first map frame must not drop catalogue Places").toBe(widest);

      // The map and the rows must agree on that same set.
      await expect(page.locator("div.singgah-home-map")).toHaveAttribute(
        "data-singgah-map",
        "ready",
        { timeout: 15000 },
      );
      await expect(page.locator(".singgah-home-map .singgah-pin").first()).toBeVisible({
        timeout: 15000,
      });
      expect(await page.locator(".singgah-home-map .singgah-pin").count()).toBe(settled);

      // And nothing re-frames later.
      await page.waitForTimeout(1200);
      expect(await page.locator("[data-place-card-id]").count()).toBe(widest);
      await context.close();
    });

    /**
     * LOCATION GRANTED (regression, 2026-10-23): once a real fix exists the
     * camera moves to the user's area — once — and the rows follow it without
     * jumping again. Requires a secure context, because browsers only honour
     * `navigator.geolocation` on https/localhost; an insecure target is
     * reported as skipped rather than silently passing.
     */
    test("a real fix moves the camera to the user area exactly once", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        permissions: ["geolocation"],
        geolocation: { latitude: 26.3642, longitude: 50.1989 },
      });
      try {
        const page = await context.newPage();
        await page.goto(base, { waitUntil: "domcontentloaded" });
        if (!(await page.evaluate(() => window.isSecureContext))) {
          test.skip(true, "geolocation needs a secure context; target is http");
          return;
        }

        await expect(page.locator(".singgah-home-map .singgah-pin").first()).toBeVisible({
          timeout: 15000,
        });
        // The user disc (its own class, drawn in the dedicated user pane) is
        // the proof the real fix reached the map.
        await expect(page.locator(".singgah-home-map path.singgah-locate-area").first()).toBeVisible(
          { timeout: 15000 },
        );

        const counts: number[] = [];
        for (let i = 0; i < 4; i += 1) {
          await page.waitForTimeout(700);
          counts.push(await page.locator("[data-place-card-id]").count());
        }
        // Settled, not oscillating: the last three samples must agree.
        expect(counts[3]).toBe(counts[2]);
        expect(counts[2]).toBe(counts[1]);
        // Markers and rows still agree after the move.
        expect(await page.locator(".singgah-home-map .singgah-pin").count()).toBe(counts[3]);
      } finally {
        await context.close();
      }
    });
  });
}
