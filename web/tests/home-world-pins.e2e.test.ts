import { test, expect, type Page } from "@playwright/test";

/**
 * WORLD-SCALE PIN SCALE + LOCATION INVITE CARD (2026-10-26).
 *
 * The single focus of this spec is the HOME frame at a WIDE map scale (the
 * no-location catalogue frame, `data-singgah-map-frame="catalogue"`), measured
 * at 390×844 with geolocation DENIED and the basemap intercepted so the run
 * needs no live tile server.
 *
 * What it measures and then locks:
 *   1. PIN SCALE — on a wide frame every Place pin paints SMALL
 *      (`.singgah-pin-art` ≈ 50–60 % of its normal box) and NO name chip is
 *      painted (`data-label-state="always"` count = 0), while the transparent
 *      40×44 tap pad and every marker's identity are untouched.
 *   2. NORMAL SCALE — a granted 1 km preset (z ≈ 13–14) keeps the full-size
 *      pin and the normal painted chips.
 *   3. THE THRESHOLD IS THE LEAFLET ZOOM, not the frame: one mouse-wheel step
 *      across the threshold flips `data-pin-scale` on the CONTAINER while the
 *      marker elements themselves are never rebuilt (same count, same nodes).
 *   4. A pin tap still selects its card, and the SELECTED pin paints normal
 *      and labelled even on a compact frame.
 *   5. The invite card (`[data-home-invite-card]`) never covers a pin, the
 *      "Tempat Pilihan" tab, the header, the filter row, or the top edge of
 *      the results panel — counted from real rects — and it is click-through
 *      outside the card itself.
 *   6. Its button really asks the browser for a location; the card disappears
 *      once a location exists; with no geolocation it renders its honest copy
 *      without a button and without a hydration mismatch.
 *   7. The invite card and the viewport empty-state overlay are mutually
 *      exclusive.
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

/** The ONLY tile host the map uses (`OSM_TILE_URL` in components/home-map.tsx). */
const TILE_ROUTE = "**/tile.openstreetmap.org/**";

/** Mock fix: Bandung, inside the Indonesian catalogue (same as the camera spec). */
const MOCK_FIX = { latitude: -6.9175, longitude: 107.6191 };

/** The invite card's hook (see home-discovery.tsx). */
const INVITE_CARD = "[data-home-invite-card]";
const INVITE_BUTTON = "[data-home-invite-locate]";

/** Answer every geolocation request with a DENIAL — no coordinate is invented. */
async function denyGeolocation(page: Page) {
  await page.addInitScript(() => {
    const geo = navigator.geolocation;
    if (!geo) return;
    geo.getCurrentPosition = (_ok, err) => {
      setTimeout(
        () => err?.({ code: 1, PERMISSION_DENIED: 1, message: "User denied Geolocation" } as GeolocationPositionError),
        600,
      );
    };
  });
}

/** Serve every basemap request locally (recorded zooms are read from the DOM). */
async function blockTiles(page: Page) {
  await page.route(TILE_ROUTE, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG }),
  );
}

type PinProbe = {
  frame: string | null;
  scale: string | null;
  pins: number;
  markers: number;
  paintedLabels: number;
  art: { w: number; h: number; top: number; bottom: number; left: number; right: number } | null;
  hit: { w: number; h: number; top: number; bottom: number; left: number; right: number } | null;
  tileZooms: number[];
  maxTileZoom: number | null;
};

/** One read of everything the pin-scale rules decide (no layout recursion). */
const readPins = (page: Page): Promise<PinProbe> =>
  page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return {
        w: Math.round(box.width * 10) / 10,
        h: Math.round(box.height * 10) / 10,
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        left: Math.round(box.left),
        right: Math.round(box.right),
      };
    };
    const zooms = [
      ...new Set(
        [...document.querySelectorAll("img.leaflet-tile")]
          .map((img) => Number((img.getAttribute("src") ?? "").match(/\/(\d+)\//)?.[1]))
          .filter((zoom) => Number.isFinite(zoom)),
      ),
    ];
    const container = document.querySelector("div.singgah-home-map");
    return {
      frame: container?.getAttribute("data-singgah-map-frame") ?? null,
      scale: container?.getAttribute("data-pin-scale") ?? null,
      pins: document.querySelectorAll(".singgah-home-map .singgah-pin").length,
      markers: document.querySelectorAll(".singgah-map-marker").length,
      paintedLabels: document.querySelectorAll('.singgah-pin-label[data-label-state="always"]').length,
      art: rect(document.querySelector(".singgah-home-map .singgah-pin-art")),
      hit: rect(document.querySelector(".singgah-home-map .singgah-pin-hit")),
      tileZooms: zooms,
      maxTileZoom: zooms.length ? Math.max(...zooms) : null,
    };
  });

/** Geometry of the invite card against every surface it may never cover. */
const readCardGeometry = (page: Page) =>
  page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height };
    };
    const hits = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
      !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const card = document.querySelector("[data-home-invite-card]");
    const cardBox = box(card);
    const pinBoxes = [...document.querySelectorAll(".singgah-home-map .singgah-pin")].map(box);
    const tab = box(document.querySelector("[data-curated-map-tab]"));
    const sheet = box(document.querySelector("section.singgah-sheet"));
    const filter = box(document.querySelector('div[class*="auto_repeat"]'));
    const nav = document.querySelector('nav[aria-label="Navigasi utama"]');
    const header = box(nav?.closest("header") ?? nav?.parentElement?.parentElement ?? null);
    const wrapper = card?.closest(".pointer-events-none") ?? null;
    const firstCard = box(document.querySelector("[data-place-card-id]"));
    // Largest pin-free horizontal band above the panel (the free band the
    // placement had to fit into), measured from the real pin rects.
    const pinTops = pinBoxes.map((b) => b!.top);
    const pinBottoms = pinBoxes.map((b) => b!.bottom);
    return {
      card: cardBox,
      role: card?.getAttribute("role") ?? null,
      ariaLive: card?.getAttribute("aria-live") ?? null,
      pins: pinBoxes.length,
      pinOverlaps: cardBox ? pinBoxes.filter((b) => hits(cardBox, b)).length : null,
      pinTop: pinTops.length ? Math.min(...pinTops) : null,
      pinBottom: pinBottoms.length ? Math.max(...pinBottoms) : null,
      tab,
      tabOverlap: hits(cardBox, tab),
      filter,
      filterOverlap: hits(cardBox, filter),
      header,
      headerOverlap: hits(cardBox, header),
      sheetTop: sheet?.top ?? null,
      panelOverlap: hits(cardBox, sheet),
      panelTopEdgeCovered: !!cardBox && !!sheet ? cardBox.bottom > sheet.top : null,
      firstCardTop: firstCard?.top ?? null,
      wrapperPointer: wrapper ? getComputedStyle(wrapper).pointerEvents : null,
      cardPointer: card ? getComputedStyle(card).pointerEvents : null,
      buttons: document.querySelectorAll("[data-home-invite-locate]").length,
      filterBottom: filter?.bottom ?? null,
      text: (card as HTMLElement | null)?.innerText ?? null,
      emptyStateVisible:
        [...document.querySelectorAll("section div")].some((el) =>
          /Belum ada Tempat/.test(el.textContent ?? ""),
        ) && !!document.querySelector(".singgah-home-map"),
    };
  });

if (!underNodeTestRunner) {
  if (base === "") {
    test.skip(true, "BASE_URL is not set; nothing to frame");
  }

  test.describe("home world pins / invite card (390×844, geolocation denied)", () => {
    /** 1. THE COMPACT FRAME — the "before/after" size, chip and tap measurement. */
    test("1) catalogue frame paints compact pins with no name chips", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await blockTiles(page);
        await denyGeolocation(page);
        await page.goto(base, { waitUntil: "commit" });

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map-frame", "catalogue", { timeout: 25_000 });
        await expect(map).toHaveAttribute("data-singgah-map", "ready", { timeout: 25_000 });
        // The label/scale pass runs with the marker rebuild; the viewport
        // report lands ~150 ms after readiness.
        await page.waitForTimeout(900);

        const probe = await readPins(page);
        console.log(`[1] catalogue probe: ${JSON.stringify(probe)}`);
        console.log(
          `[1] art h=${probe.art?.h} → ${(probe.art ? probe.art.h / 31 : 0).toFixed(2)} of the 31px normal box`,
        );

        expect(probe.frame).toBe("catalogue");
        expect(probe.pins, "the whole catalogue must be pinned").toBeGreaterThan(10);
        // THE FIX: one data attribute on the container, not per marker.
        expect(probe.scale, "a wide frame must switch the container to compact").toBe("compact");
        // ~50–60 % of the 24×31 artwork (normal is measured in case 2).
        expect(probe.art?.h, "the compact pin must be visibly smaller").toBeLessThanOrEqual(20);
        expect(probe.art?.h, "the compact pin must stay visible").toBeGreaterThanOrEqual(14);
        // No chip is painted at a wide zoom — the selected Place is the only
        // exception and nothing is selected here.
        expect(probe.paintedLabels, "no name chip may be painted on a wide frame").toBe(0);
        // The tap pad is CSS-identical in both modes.
        expect(probe.hit?.w, "the tap pad stays 40px wide").toBeGreaterThanOrEqual(40);
        expect(probe.hit?.h, "the tap pad stays 44px tall").toBeGreaterThanOrEqual(44);
        // The catalogue frame is a world-scale frame (z ≈ 2).
        expect(probe.maxTileZoom ?? 99, "the catalogue frame is world scale").toBeLessThanOrEqual(3);
      } finally {
        await context.close();
      }
    });

    /** 2. THE NORMAL FRAME — a granted 1 km preset keeps full-size pins + chips. */
    test("2) a granted 1 km frame keeps normal pins and painted chips", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        permissions: ["geolocation"],
        geolocation: { latitude: MOCK_FIX.latitude, longitude: MOCK_FIX.longitude },
      });
      try {
        const page = await context.newPage();
        await blockTiles(page);
        await page.goto(base, { waitUntil: "commit" });

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map-frame", "origin", { timeout: 25_000 });
        await page.waitForTimeout(900);

        const probe = await readPins(page);
        console.log(`[2] origin probe: ${JSON.stringify(probe)}`);

        expect(probe.scale, "a close frame must be normal").toBe("normal");
        expect(probe.art?.h, "the normal pin is the full 31px artwork").toBeGreaterThanOrEqual(30);
        expect(probe.paintedLabels, "a close frame paints its chips").toBeGreaterThan(0);
        expect(probe.maxTileZoom ?? 0, "the 1 km preset is a close frame (z ≈ 13–14)").toBeGreaterThanOrEqual(13);
        expect(probe.hit?.w).toBeGreaterThanOrEqual(40);
        expect(probe.hit?.h).toBeGreaterThanOrEqual(44);
      } finally {
        await context.close();
      }
    });

    /** 3. THE THRESHOLD IS THE ZOOM — and crossing it never rebuilds a marker. */
    test("3) a wheel across the threshold flips the attribute without rebuilding markers", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        permissions: ["geolocation"],
        geolocation: { latitude: MOCK_FIX.latitude, longitude: MOCK_FIX.longitude },
      });
      try {
        const page = await context.newPage();
        await blockTiles(page);
        await page.goto(base, { waitUntil: "commit" });

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map-frame", "origin", { timeout: 25_000 });
        await page.waitForTimeout(900);

        // 60 px of wheel = ONE Leaflet zoom level (`wheelPxPerZoomLevel: 60`).
        await page.mouse.move(195, 300);
        const track: { zoom: number | null; scale: string | null; painted: number; markers: number }[] = [];
        let flippedAt: number | null = null;
        for (let step = 0; step < 8; step += 1) {
          const probe = await readPins(page);
          track.push({
            zoom: probe.maxTileZoom,
            scale: probe.scale,
            painted: probe.paintedLabels,
            markers: probe.markers,
          });
          if (probe.scale === "compact") {
            flippedAt = probe.maxTileZoom;
            break;
          }
          await page.mouse.wheel(0, 60);
          await page.waitForTimeout(750);
        }
        console.log(`[3] zoom track: ${JSON.stringify(track)}`);
        expect(flippedAt, "zooming out must reach the compact scale").not.toBeNull();
        // The compact band covers the Gulf/country scale (z ≈ 6)…
        expect(flippedAt!, "…but only after the country scale").toBeGreaterThanOrEqual(7);
        // …and stops well below the 1 km preset (z ≈ 13–14) and city zooms.
        expect(flippedAt!, "the threshold sits between a city and a country").toBeLessThanOrEqual(11);

        // THE REBUILD PROOF: tag every marker node at the compact zoom, then
        // take the same snapshot again — the attribute lives on the container,
        // so no marker may be re-created by the flip itself.
        const tagged = await page.evaluate(() => {
          const nodes = [...document.querySelectorAll(".singgah-map-marker")];
          nodes.forEach((node) => {
            (node as unknown as { __pinProbe?: number }).__pinProbe = 1;
          });
          return nodes.length;
        });
        await page.mouse.wheel(0, 60);
        await page.waitForTimeout(900);
        const after = await readPins(page);
        const identity = await page.evaluate(() => {
          const nodes = [...document.querySelectorAll(".singgah-map-marker")];
          return {
            total: nodes.length,
            tagged: nodes.filter((node) => (node as unknown as { __pinProbe?: number }).__pinProbe === 1)
              .length,
          };
        });
        console.log(
          `[3] after the flip: ${JSON.stringify({ tagged, after: { scale: after.scale, zoom: after.maxTileZoom, painted: after.paintedLabels, markers: after.markers }, identity })}`,
        );
        expect(identity.total, "the marker count must not move with the scale").toBe(tagged);
        expect(identity.tagged, "the SAME marker nodes must survive the flip").toBe(tagged);
        expect(after.scale).toBe("compact");
        expect(after.paintedLabels, "the compact zoom paints no chip").toBe(0);
      } finally {
        await context.close();
      }
    });

    /** 4. A PIN TAP — selection, card, and a SELECTED pin that is normal + labelled. */
    test("4) tapping a pin still selects its card and the selected pin paints normal", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await blockTiles(page);
        await denyGeolocation(page);
        await page.goto(base, { waitUntil: "commit" });

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map-frame", "catalogue", { timeout: 25_000 });
        await page.waitForTimeout(900);

        // A point INSIDE a pin's 40×44 pad that is really the top element: the
        // pad centre first, then a 3×3 grid, because the floating tab and the
        // panel legitimately sit on part of some pads on this frame.
        const target = await page.evaluate(() => {
          const pins = [...document.querySelectorAll(".singgah-home-map .singgah-pin")];
          for (const pin of pins) {
            const hit = pin.querySelector(".singgah-pin-hit");
            if (!hit) continue;
            const b = hit.getBoundingClientRect();
            const xs = [b.left + b.width / 2, b.left + b.width * 0.25, b.left + b.width * 0.75];
            const ys = [b.top + b.height / 2, b.top + b.height * 0.2, b.top + b.height * 0.8];
            for (const y of ys) {
              for (const x of xs) {
                if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
                const top = document.elementFromPoint(x, y);
                if (top && pin.contains(top)) return { x, y };
              }
            }
          }
          return null;
        });
        expect(target, "a tappable pin must exist on the compact frame").not.toBeNull();

        await page.mouse.click(target!.x, target!.y);
        await page.waitForTimeout(1_200);

        const state = await page.evaluate(() => {
          const highlighted = document.querySelector(".singgah-map-marker.is-highlighted");
          const art = highlighted?.querySelector(".singgah-pin-art") ?? null;
          const label = highlighted?.querySelector(".singgah-pin-label") ?? null;
          const selectedCard = [...document.querySelectorAll("[data-place-card-id]")].find((card) =>
            card.className.includes("ring-2"),
          );
          return {
            highlighted: !!highlighted,
            artH: art ? art.getBoundingClientRect().height : null,
            labelState: label?.getAttribute("data-label-state") ?? null,
            labelVisible: label ? getComputedStyle(label).visibility : null,
            cardSelected: !!selectedCard,
            scale: document.querySelector("div.singgah-home-map")?.getAttribute("data-pin-scale"),
            painted: document.querySelectorAll('.singgah-pin-label[data-label-state="always"]').length,
          };
        });
        console.log(`[4] after the pin tap: ${JSON.stringify(state)}`);
        expect(state.highlighted, "the tapped pin is highlighted").toBe(true);
        expect(state.cardSelected, "the tapped pin selects its card").toBe(true);
        expect(state.scale, "the frame itself is still compact").toBe("compact");
        expect(state.artH, "the SELECTED pin paints at the normal size").toBeGreaterThanOrEqual(30);
        expect(state.labelState, "the SELECTED pin keeps its chip").toBe("always");
        expect(state.labelVisible).toBe("visible");
        expect(state.painted, "only the selected chip is painted here").toBe(1);
      } finally {
        await context.close();
      }
    });

    /** 5. INVITE CARD GEOMETRY — measured against every surface it may not cover. */
    test("5) the invite card covers no pin, tab, header, filter row, or panel edge", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await blockTiles(page);
        await denyGeolocation(page);
        await page.goto(base, { waitUntil: "commit" });

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map-frame", "catalogue", { timeout: 25_000 });
        await page.waitForTimeout(900);

        // BEFORE the card exists: the free band its placement has to fit into.
        const band = await page.evaluate(() => {
          const box = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
          const pins = [...document.querySelectorAll(".singgah-home-map .singgah-pin")].map((p) => box(p)!);
          const tab = box(document.querySelector("[data-curated-map-tab]"));
          const sheet = box(document.querySelector("section.singgah-sheet"));
          const filter = box(document.querySelector('div[class*="auto_repeat"]'));
          const nav = document.querySelector('nav[aria-label="Navigasi utama"]');
          const header = box(nav?.closest("header") ?? nav?.parentElement?.parentElement ?? null);
          const rows = [...pins, tab, sheet, filter, header].filter(Boolean) as DOMRect[];
          const free: [number, number][] = [];
          let start: number | null = null;
          let prev = -2;
          for (let y = 0; y <= 844; y += 1) {
            const blocked = rows.some((r) => r.top <= y && r.bottom >= y);
            if (!blocked) {
              if (start === null) start = y;
            } else if (start !== null) {
              free.push([start, prev]);
              start = null;
            }
            if (!blocked) prev = y;
          }
          if (start !== null) free.push([start, prev]);
          return {
            pinTop: Math.min(...pins.map((p) => p.top)),
            pinBottom: Math.max(...pins.map((p) => p.bottom)),
            tabTop: tab?.top ?? null,
            tabBottom: tab?.bottom ?? null,
            sheetTop: sheet?.top ?? null,
            filterBottom: filter?.bottom ?? null,
            headerBottom: header?.bottom ?? null,
            freeBands: free.filter(([a, b]) => b - a >= 20),
          };
        });
        console.log(`[5] free band on main: ${JSON.stringify(band)}`);

        await expect(page.locator(INVITE_CARD), "the invite card must be rendered").toBeVisible({
          timeout: 15_000,
        });
        await page.waitForTimeout(200);
        const geo = await readCardGeometry(page);
        console.log(`[5] card geometry: ${JSON.stringify(geo)}`);

        expect(geo.card, "the card has a real box").not.toBeNull();
        expect(geo.role).toBe("status");
        expect(geo.ariaLive).toBe("polite");
        expect(geo.pinOverlaps, "the card covers no pin").toBe(0);
        expect(geo.tabOverlap, "the card covers no 'Tempat Pilihan' tab").toBe(false);
        expect(geo.filterOverlap, "the card covers no filter-row control").toBe(false);
        expect(geo.headerOverlap, "the card covers no header control").toBe(false);
        expect(geo.panelTopEdgeCovered, "the card stays clear of the panel's top edge").toBe(false);
        expect(geo.panelOverlap, "the card never floats over the results panel").toBe(false);
        // Click-through outside the card itself.
        expect(geo.wrapperPointer, "the overlay stays click-through").toBe("none");
        expect(geo.cardPointer, "only the card opts back in").toBe("auto");
        // The card sits ABOVE the pin band, in the measured free band.
        expect(geo.card!.top, "the card is below the filter row").toBeGreaterThanOrEqual(
          geo.filterBottom ?? 0,
        );
        expect(geo.card!.bottom, "the card stays above the pin band").toBeLessThanOrEqual(
          geo.pinTop ?? 844,
        );
        // Mutual exclusivity with the empty-state overlay in this state.
        expect(geo.emptyStateVisible, "no empty-state overlay while the card is up").toBe(false);
      } finally {
        await context.close();
      }
    });

    /** 6. THE BUTTON — one press really asks the browser for the location. */
    test("6) the invite button asks the browser for a location", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await blockTiles(page);
        await page.addInitScript(() => {
          const w = window as unknown as { __geoCalls?: number };
          w.__geoCalls = 0;
          const geo = navigator.geolocation;
          if (!geo) return;
          const original = geo.getCurrentPosition.bind(geo);
          geo.getCurrentPosition = (ok, err, opts) => {
            w.__geoCalls = (w.__geoCalls ?? 0) + 1;
            // Keep the app in its honest "denied" state — no coordinate.
            setTimeout(() => err?.({ code: 1, message: "denied" } as GeolocationPositionError), 300);
            void original;
            void ok;
            void opts;
          };
        });
        await page.goto(base, { waitUntil: "commit" });

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map-frame", "catalogue", { timeout: 25_000 });
        await expect(page.locator(INVITE_CARD)).toBeVisible({ timeout: 15_000 });

        const before = await page.evaluate(
          () => (window as unknown as { __geoCalls?: number }).__geoCalls ?? 0,
        );
        await page.locator(INVITE_BUTTON).click();
        await page.waitForTimeout(700);
        const after = await page.evaluate(
          () => (window as unknown as { __geoCalls?: number }).__geoCalls ?? 0,
        );
        console.log(`[6] geolocation calls before=${before} after=${after}`);
        expect(after, "the button must trigger a fresh geolocation request").toBeGreaterThan(before);
        // The card is still the same honest state (no location was invented).
        await expect(page.locator(INVITE_CARD)).toBeVisible();
      } finally {
        await context.close();
      }
    });

    /** 7. A LOCATION EXISTS — the invite card leaves the screen. */
    test("7) the invite card disappears once a location exists", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        permissions: ["geolocation"],
        geolocation: { latitude: MOCK_FIX.latitude, longitude: MOCK_FIX.longitude },
      });
      try {
        const page = await context.newPage();
        await blockTiles(page);
        await page.goto(base, { waitUntil: "commit" });

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map-frame", "origin", { timeout: 25_000 });
        await page.waitForTimeout(900);
        expect(await page.locator(INVITE_CARD).count(), "no invite once a fix exists").toBe(0);
        expect(await page.locator(INVITE_BUTTON).count()).toBe(0);
      } finally {
        await context.close();
      }
    });

    /** 8. NO GEOLOCATION — honest copy, no button, no hydration mismatch. */
    test("8) without geolocation the card renders its honest copy and hydrates cleanly", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        const hydration: string[] = [];
        const isHydrationComplaint = (text: string) =>
          /hydrat|did not match|server[- ]rendered|Minified React error #(418|419|421|422|423|425)/i.test(
            text,
          );
        page.on("console", (message) => {
          const text = message.text();
          if (isHydrationComplaint(text)) hydration.push(`${message.type()}: ${text}`);
        });
        page.on("pageerror", (error) => {
          const text = `${error.name}: ${error.message}`;
          if (isHydrationComplaint(text)) hydration.push(`pageerror: ${text}`);
        });
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "geolocation", {
            configurable: true,
            get: () => undefined,
          });
        });
        await blockTiles(page);
        await page.goto(base, { waitUntil: "commit" });

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map-frame", "catalogue", { timeout: 25_000 });
        await page.waitForTimeout(1_400);

        const state = await readCardGeometry(page);
        console.log(`[8] no-geolocation card: ${JSON.stringify(state)}`);
        console.log(`[8] hydration complaints: ${JSON.stringify(hydration)}`);
        expect(state.card, "the card still explains the frame").not.toBeNull();
        expect(state.buttons, "no location action for a browser without geolocation").toBe(0);
        expect(state.text ?? "").toContain("Jelajahi semua tempat");
        expect(state.text ?? "").toContain("Peta ini menampilkan semua tempat.");
        expect(state.pinOverlaps, "the card still covers no pin").toBe(0);
        expect(hydration, "server HTML and the first client render must agree").toEqual([]);
      } finally {
        await context.close();
      }
    });

    /** 9. MUTUAL EXCLUSION with the viewport empty-state overlay. */
    test("9) the invite card and the empty-state overlay never show together", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await blockTiles(page);
        await denyGeolocation(page);
        await page.goto(base, { waitUntil: "commit" });

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map-frame", "catalogue", { timeout: 25_000 });
        await page.waitForTimeout(900);
        // The honest empty-state card's second line — unique to that overlay.
        const emptyOverlay = page.getByText("Geser peta dengan dua jari untuk melihat area lain.", {
          exact: false,
        });

        const shown = async () => ({
          card: await page.locator(INVITE_CARD).count(),
          empty: await emptyOverlay.count(),
        });
        console.log(`[9] at the catalogue frame: ${JSON.stringify(await shown())}`);
        expect((await shown()).card).toBe(1);
        expect((await shown()).empty).toBe(0);

        // Wheel INTO the ocean at the centre of the catalogue frame: the
        // viewport holds no Place, so the honest empty state takes over.
        await page.mouse.move(195, 300);
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(1_200);
        const mid = await shown();
        console.log(`[9] with an empty viewport: ${JSON.stringify(mid)}`);
        expect(mid.empty, "the empty state must appear").toBeGreaterThan(0);
        expect(mid.card, "the invite card must leave while the empty state is up").toBe(0);

        // …and it comes straight back when the places return.
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(1_200);
        const back = await shown();
        console.log(`[9] back on the catalogue frame: ${JSON.stringify(back)}`);
        expect(back.card).toBe(1);
        expect(back.empty).toBe(0);
      } finally {
        await context.close();
      }
    });
  });
}
