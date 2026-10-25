import { test, expect, type Page } from "@playwright/test";

/**
 * INITIAL CAMERA + "1 km" TAB (audit, 2026-10-25).
 *
 * What this file locks, using only selectors that already exist in the app:
 *   · `div.singgah-home-map[data-singgah-map]`            → "ready" after the frame
 *   · `div.singgah-home-map[data-singgah-map-frame]`      → "origin" | "catalogue"
 *   · `.singgah-home-map .singgah-pin`                    → one pin per framed Place
 *   · `[data-place-card-id]`                              → one row per listed Place
 *   · `[data-home-locate]` / `.singgah-user-pane path`    → the "Lokasi Saya" control
 *   · `.singgah-locate-area`                              → the viewer's surrounding disc
 *   · the three distance buttons (text = DISTANCE_FILTERS) → `aria-pressed`
 *
 * THE PROPERTIES (source-verified before writing this):
 *   1. `resolveActiveCenter()` (lib/live/ui.ts) answers `center: null` when there
 *      is no search center and no device fix, and `home-map.tsx` then frames the
 *      canonical catalogue spread (`data-singgah-map-frame="catalogue"`). No
 *      coordinate is invented — that design is asserted, not changed.
 *   2. With a real fix the first frame is the 1 km preset around it
 *      (`presetZoomForRadius`, radius = CAMERA_PRESET_RADIUS_M["1 km"] = 1000 m),
 *      painted BEFORE any tile layer exists — so a world-scale tile can never
 *      be the first basemap.
 *   3. The distance tab's pressed state is a UI claim about an anchored radius.
 *      Without a center it must not claim one; while the first fix is still in
 *      flight it stays pressed (no flicker), which is why `viewerSettled` is
 *      part of the rule.
 *
 * Tile traffic is intercepted (`page.route`) so the run needs no live tile
 * server, and every requested z/x/y is recorded from navigation onwards.
 *
 * RUNNER GUARD: `tests/**` is also globbed by the project unit suite
 * (`tsx --test`). Node's test runner sets NODE_TEST_CONTEXT in each child; when
 * it is present this module registers no Playwright tests.
 */

const underNodeTestRunner = (process.env.NODE_TEST_CONTEXT ?? "") !== "";
const base = process.env.BASE_URL ?? "";

/** 1×1 transparent PNG (valid IHDR) so Leaflet's image loads succeed. */
const TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * The ONLY tile host the map uses (`OSM_TILE_URL` in components/home-map.tsx).
 * The provider is not changed here; every request is answered locally.
 */
const TILE_ROUTE = "**/tile.openstreetmap.org/**";

/**
 * Radius of the default "1 km" preset — mirrors
 * `CAMERA_PRESET_RADIUS_M["1 km"]` in lib/live/ui.ts (1000). It is duplicated
 * rather than imported so this browser spec stays free of the app's aliased
 * module graph; the assertion below would fail loudly if the preset changed.
 */
const RADIUS_1KM_M = 1_000;

/** Mock fix: Bandung, inside the Indonesian catalogue (real coordinates). */
const MOCK_FIX = { latitude: -6.9175, longitude: 107.6191 };

type TileHit = { z: number; x: number; y: number };

/** Record every tile requested from navigation onwards; serve a blank PNG. */
async function captureTiles(page: Page): Promise<TileHit[]> {
  const hits: TileHit[] = [];
  await page.route(TILE_ROUTE, async (route) => {
    const url = route.request().url();
    const match = /tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/.exec(url);
    if (match) hits.push({ z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) });
    await route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG });
  });
  return hits;
}

/**
 * Delay the browser's own geolocation callbacks (the same technique the Home
 * smoke test uses). Playwright resolves an already-decided permission in ~1 ms,
 * which is faster than a map can paint; a real phone answers in 200–1500 ms.
 * This postpones the callback only — no coordinate is invented.
 */
async function delayGeolocation(page: Page, ms: number) {
  await page.addInitScript((delay) => {
    const geo = navigator.geolocation;
    if (!geo) return;
    const original = geo.getCurrentPosition.bind(geo);
    geo.getCurrentPosition = (ok, err, opts) => setTimeout(() => original(ok, err, opts), delay);
  }, ms);
}

const mapBox = async (page: Page) => {
  const box = await page.locator("div.singgah-home-map").first().boundingBox();
  expect(box, "the map container must have a measurable box").not.toBeNull();
  return { width: Math.round(box!.width), height: Math.round(box!.height) };
};

/** The "1 km" distance tab (its accessible name IS the filter label). */
const radiusTab = (page: Page) => page.getByRole("button", { name: "1 km", exact: true });

const EARTH_RADIUS_M = 6_378_137;

function projectMercator(lat: number, lng: number) {
  const d = Math.PI / 180;
  return {
    x: EARTH_RADIUS_M * lng * d,
    y: EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (lat * d) / 2)),
  };
}

/**
 * Mirror of `presetZoomForRadius()` + Leaflet's `getBoundsZoom(bounds, false)`
 * (EPSG:3857, zoomSnap 1, no padding), from the mock coordinate and the REAL
 * map viewport. `getBoundsZoom` returns an integer level; the preset subtracts
 * 0.5 and Leaflet requests tiles at the rounded level.
 */
function expectedPresetTileZoom(
  fix: { latitude: number; longitude: number },
  radiusM: number,
  box: { width: number; height: number },
): number {
  const latDelta = radiusM / 111_320;
  const lngDelta = radiusM / (111_320 * Math.max(0.1, Math.cos((fix.latitude * Math.PI) / 180)));
  const northEast = projectMercator(fix.latitude + latDelta, fix.longitude + lngDelta);
  const southWest = projectMercator(fix.latitude - latDelta, fix.longitude - lngDelta);
  const worldWidth = 2 * Math.PI * EARTH_RADIUS_M;
  const boundsWidthAtZoom0 = ((northEast.x - southWest.x) / worldWidth) * 256;
  const boundsHeightAtZoom0 = ((northEast.y - southWest.y) / worldWidth) * 256;
  const raw = Math.log2(
    Math.min(box.width / boundsWidthAtZoom0, box.height / boundsHeightAtZoom0),
  );
  const boundsZoom = Math.max(2, Math.min(19, Math.floor(raw)));
  return Math.round(boundsZoom - 0.5);
}

if (!underNodeTestRunner) {
  if (base === "") {
    test.skip(true, "BASE_URL is not set; nothing to frame");
  }

  test.describe("home-initial-camera / 1 km preset", () => {
    /**
     * (a) GRANTED FROM THE START — the fallback frame that produced the
     * "global map first, then it changes" report is impossible here: the very
     * first tile batch must already be the 1 km preset, and no world-scale
     * (z <= 5) tile may ever be requested.
     */
    test("(a) a fix granted from the start opens on the 1 km origin frame", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        permissions: ["geolocation"],
        geolocation: { latitude: MOCK_FIX.latitude, longitude: MOCK_FIX.longitude },
      });
      try {
        const page = await context.newPage();
        const tiles = await captureTiles(page);
        await page.goto(base, { waitUntil: "commit" });

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map-frame", "origin", {
          timeout: 20_000,
        });

        // Snapshot taken at the frame decision: these are the FIRST requests.
        const firstBatch = tiles.slice();
        console.log(`[a] first tile batch: ${JSON.stringify(firstBatch.map((t) => t.z))}`);

        expect(firstBatch.length, "the 1 km frame must request tiles").toBeGreaterThan(0);
        const box = await mapBox(page);
        const expected = expectedPresetTileZoom(MOCK_FIX, RADIUS_1KM_M, box);
        console.log(`[a] map ${box.width}x${box.height}, expected tile z=${expected}`);
        expect(
          Math.abs(firstBatch[0].z - expected),
          `first tile z=${firstBatch[0].z}, 1 km preset z=${expected}`,
        ).toBeLessThanOrEqual(1);
        expect(
          firstBatch.filter((t) => t.z <= 5).map((t) => `z${t.z}`),
          "a known fix must never paint a world-scale (global) basemap first",
        ).toEqual([]);

        // The tab claims the anchored 1 km radius, and it really is anchored.
        await expect(radiusTab(page)).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator(".singgah-home-map .singgah-locate-area").first()).toBeVisible({
          timeout: 15_000,
        });

        // ...and nothing drops back to a world frame later.
        await page.waitForTimeout(800);
        expect(
          tiles.filter((t) => t.z <= 5).map((t) => `z${t.z}`),
          "no world-scale tile after the local frame either",
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });

    /**
     * (b) FIX LATE — the map is already created while the first fix is still in
     * flight. The held-frame rule must keep the basemap unpainted (no global
     * tile, no frame decision), then paint the LOCAL frame once.
     */
    test("(b) a late fix never paints a global basemap first", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        permissions: ["geolocation"],
        geolocation: { latitude: MOCK_FIX.latitude, longitude: MOCK_FIX.longitude },
      });
      try {
        const page = await context.newPage();
        await delayGeolocation(page, 3_000);
        const tiles = await captureTiles(page);
        await page.goto(base, { waitUntil: "commit" });

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toBeVisible({ timeout: 15_000 });

        // PENDING WINDOW: the map exists, the outcome is unknown.
        const pending: { tiles: number; frame: string | null }[] = [];
        for (let i = 0; i < 12; i += 1) {
          pending.push({
            tiles: tiles.length,
            frame: await map.getAttribute("data-singgah-map-frame"),
          });
          await page.waitForTimeout(100);
        }
        console.log(`[b] pending samples: ${JSON.stringify(pending)}`);
        expect(
          pending.some((sample) => sample.frame === null),
          "the fix must still be pending while the map exists (else this scenario is not exercised)",
        ).toBe(true);
        expect(
          pending.filter((sample) => sample.frame === null && sample.tiles > 0),
          "no basemap may be painted before the first-frame decision",
        ).toEqual([]);

        await expect(map).toHaveAttribute("data-singgah-map-frame", "origin", {
          timeout: 20_000,
        });
        const box = await mapBox(page);
        const expected = expectedPresetTileZoom(MOCK_FIX, RADIUS_1KM_M, box);
        expect(tiles.length, "the local frame must request tiles").toBeGreaterThan(0);
        console.log(`[b] tile zooms: ${JSON.stringify(tiles.map((t) => t.z))} expected=${expected}`);
        expect(
          Math.abs(tiles[0].z - expected),
          `first tile z=${tiles[0].z}, 1 km preset z=${expected}`,
        ).toBeLessThanOrEqual(1);
        expect(
          tiles.filter((t) => t.z <= 5).map((t) => `z${t.z}`),
          "a late fix must not have painted a global frame",
        ).toEqual([]);

        // The tab stays/becomes the selected radius once the fix exists.
        await expect(radiusTab(page)).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator(".singgah-home-map .singgah-locate-area").first()).toBeVisible({
          timeout: 15_000,
        });
      } finally {
        await context.close();
      }
    });

    /**
     * (c) NO FIX (permission denied) — the documented, permitted no-origin
     * view: the catalogue spread, the whole catalogue listed, no user marker,
     * no invented coordinate, one stable zoom, and NO pressed 1 km tab.
     */
    test("(c) without a fix the catalogue frame is used and 1 km is not pressed", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await delayGeolocation(page, 1_200);
        const tiles = await captureTiles(page);
        await page.goto(base, { waitUntil: "commit" });

        // Catalogue baseline before the map narrows anything to its viewport.
        let catalogue = 0;
        for (let i = 0; i < 20; i += 1) {
          catalogue = Math.max(catalogue, await page.locator("[data-place-card-id]").count());
          await page.waitForTimeout(100);
        }
        expect(catalogue, "Home must render its catalogue").toBeGreaterThan(0);
        console.log(`[c] catalogue rows before narrowing: ${catalogue}`);

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map-frame", "catalogue", {
          timeout: 20_000,
        });
        await expect(map).toHaveAttribute("data-singgah-map", "ready", { timeout: 20_000 });

        // No synthetic position: no user pin, no surrounding disc, no label.
        expect(await page.locator(".singgah-home-map .singgah-user-pane path").count()).toBe(0);
        expect(await page.locator(".singgah-home-map .singgah-locate-area").count()).toBe(0);
        expect(await page.getByText("Lokasi Anda").count()).toBe(0);

        // The first viewport report lands ~150 ms after `ready`; wait for it,
        // then the rows must still be the whole (unfiltered by radius) catalogue.
        await page.waitForTimeout(600);
        const rows = await page.locator("[data-place-card-id]").count();
        expect(rows, "the radius must not filter the catalogue").toBe(catalogue);
        expect(await page.locator(".singgah-home-map .singgah-pin").count()).toBe(catalogue);

        // One stable zoom: the catalogue fit is a single integer level.
        const zooms = Array.from(new Set(tiles.map((t) => t.z)));
        console.log(`[c] tile zooms requested: ${JSON.stringify(zooms)}`);
        expect(zooms, "the catalogue frame must not re-zoom").toHaveLength(1);

        // THE FIX (this is the red-before assertion): no anchor ⇒ no pressed
        // radius. Without a fix the 1 km preset has nothing to centre on.
        await expect(radiusTab(page)).toHaveAttribute("aria-pressed", "false", {
          timeout: 10_000,
        });
      } finally {
        await context.close();
      }
    });

    /**
     * (d) OBSERVATION ONLY — the geolocation callback never fires at all.
     * Nothing in the app is changed for this case; the point is to RECORD what
     * the user sees when the browser answers neither success nor failure.
     */
    test("(d) observation: a geolocation request that never answers", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await page.addInitScript(() => {
          const geo = navigator.geolocation;
          if (!geo) return;
          geo.getCurrentPosition = () => {
            /* deliberately never calls back */
          };
        });
        const tiles = await captureTiles(page);
        await page.goto(base, { waitUntil: "commit" });
        await page.waitForTimeout(3_000);

        const observation = await page.evaluate(() => {
          const mapEl = document.querySelector("div.singgah-home-map");
          const tileZooms = Array.from(mapEl?.querySelectorAll("img.leaflet-tile") ?? [])
            .map((tile) => Number((tile.getAttribute("src") ?? "").match(/\/(\d+)\/\d+\/\d+\.png/)?.[1] ?? NaN))
            .filter((zoom) => Number.isFinite(zoom));
          return {
            ready: mapEl?.getAttribute("data-singgah-map") ?? null,
            frame: mapEl?.getAttribute("data-singgah-map-frame") ?? null,
            tileImages: tileZooms.length,
            tileZooms,
            cards: document.querySelectorAll("[data-place-card-id]").length,
            pins: document.querySelectorAll(".singgah-home-map .singgah-pin").length,
            userPanePaths: document.querySelectorAll(".singgah-home-map .singgah-user-pane path").length,
          };
        });
        console.log(`[d] observation: ${JSON.stringify({ ...observation, requested: tiles.length })}`);

        // The one invariant that must hold even here: an unknown origin may
        // never be replaced by a world-scale basemap.
        expect(
          tiles.filter((t) => t.z <= 5).map((t) => `z${t.z}`),
          "a world frame may never stand in for an unknown origin",
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });

    /**
     * (e) NO GEOLOCATION AT ALL — the hydration question (2026-10-25).
     *
     * `viewerSettled` feeds the distance tab's pressed state, so its starting
     * value must be the SAME on the server and in the first client render, or
     * the tab's `aria-pressed` and its green surface differ between the two.
     * This case is exactly where a platform-derived initialiser broke: the
     * server has no `window` (it assumed "still settling" and rendered the tab
     * pressed) while this browser knows at once that there is no geolocation
     * (it rendered the tab unpressed). React warns about such an attribute
     * mismatch only in development and in production does NOT repair it, so the
     * tab stayed green for good. The value now starts `false` on both sides and
     * the "no geolocation" answer is read through `useSyncExternalStore`, whose
     * server snapshot is `false` — so the first client render matches the
     * server and the real answer arrives one commit after hydration.
     *
     * What is checked here, with no invented coordinate involved:
     *   · no hydration complaint reaches the console or the page (the detector
     *     is proven live: the total message count is printed next to it, and
     *     `#418–#425` are React's minified hydration codes in production);
     *   · the SERVER HTML renders the settling state (tab pressed) — the same
     *     value the client's first render computes, which is what makes
     *     hydration clean;
     *   · once the client answer has been applied, the settled DOM agrees: the
     *     "1 km" tab is NOT pressed, no control claims it, and the map keeps
     *     the catalogue frame with no user marker and one stable zoom.
     */
    test("(e) a browser without geolocation hydrates without a mismatch", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        const seen: string[] = [];
        const hydration: string[] = [];
        const isHydrationComplaint = (text: string) =>
          /hydrat|did not match|server[- ]rendered|Minified React error #(418|419|421|422|423|425)/i.test(
            text,
          );
        page.on("console", (message) => {
          const text = message.text();
          seen.push(`${message.type()}: ${text}`);
          if (isHydrationComplaint(text)) hydration.push(`${message.type()}: ${text}`);
        });
        page.on("pageerror", (error) => {
          const text = `${error.name}: ${error.message}`;
          seen.push(`pageerror: ${text}`);
          if (isHydrationComplaint(text)) hydration.push(`pageerror: ${text}`);
        });
        // The browser reports NO geolocation support at all (not denied —
        // absent). This is the exact case that used to make the server render
        // "settling" and the first client render "settled".
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "geolocation", {
            configurable: true,
            get: () => undefined,
          });
        });
        // The SERVER HTML, fetched without running the app, so the two renders
        // are compared directly instead of inferred.
        const ssrHtml = await (await context.request.get(base)).text();
        const ssrRadius = /aria-pressed="(true|false)"[^<>]*>\s*1 km\s*</.exec(ssrHtml);

        const tiles = await captureTiles(page);
        await page.goto(base, { waitUntil: "commit" });

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map", "ready", { timeout: 20_000 });
        await expect(map).toHaveAttribute("data-singgah-map-frame", "catalogue", {
          timeout: 20_000,
        });
        // The first viewport report lands ~150 ms after `ready`; then give
        // React room to finish hydrating and flush any warning.
        await page.waitForTimeout(600);
        await page.waitForTimeout(600);

        const state = {
          hasGeolocation: await page.evaluate(
            () => navigator.geolocation !== undefined && navigator.geolocation !== null,
          ),
          radiusPressed: await radiusTab(page).getAttribute("aria-pressed"),
          radiusClass: (await radiusTab(page).getAttribute("class")) ?? "",
          pressedButtons: await page.locator('button[aria-pressed="true"]').count(),
          frame: await map.getAttribute("data-singgah-map-frame"),
          cards: await page.locator("[data-place-card-id]").count(),
          pins: await page.locator(".singgah-home-map .singgah-pin").count(),
          userMarkers: await page.locator(".singgah-home-map .singgah-user-pane path").count(),
          tileZooms: Array.from(new Set(tiles.map((t) => t.z))),
          requested: tiles.length,
        };
        console.log(`[e] console messages seen: ${seen.length}`);
        console.log(`[e] ssr 1 km aria-pressed: ${JSON.stringify(ssrRadius?.[1] ?? null)}`);
        console.log(`[e] console sample: ${JSON.stringify(seen.slice(0, 6))}`);
        console.log(`[e] hydration complaints: ${JSON.stringify(hydration)}`);
        console.log(`[e] state: ${JSON.stringify(state)}`);

        expect(hydration, "server HTML and the first client render must agree").toEqual([]);
        expect(state.hasGeolocation, "the mock must really remove geolocation").toBe(false);
        // The server starts from the same "still settling" state the client's
        // first render computes: pressed, so the two renders agree.
        expect(ssrRadius?.[1], "the server renders the settling state").toBe("true");
        // A settled browser with no geolocation claims NO anchored radius.
        expect(state.radiusPressed).toBe("false");
        expect(state.radiusClass).not.toContain("bg-brand-primary");
        expect(state.pressedButtons, "no control claims the 1 km preset here").toBe(0);
        expect(state.frame).toBe("catalogue");
        expect(state.userMarkers, "no coordinate may be synthesised").toBe(0);
        expect(state.pins).toBe(state.cards);
        // The frame is chosen once and never re-zoomed.
        expect(state.tileZooms).toHaveLength(1);
      } finally {
        await context.close();
      }
    });
  });
}
