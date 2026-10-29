import { test, expect, type Page } from "@playwright/test";

/**
 * NO-LOCATION HOME (2026-10-25): does the catalogue frame keep its pins on the
 * part of the map a person can actually SEE?
 *
 * WHAT IS MEASURED
 *   · `div.singgah-home-map[data-singgah-map-frame]` → `catalogue` once the
 *     settled no-origin frame is painted (the existing presentation hook).
 *   · `.singgah-home-map .singgah-pin`              → one pin per framed Place.
 *   · `section.singgah-sheet`                      → the results panel; its
 *     `getBoundingClientRect().top` IS the seam the panel starts at.
 *   · `header` and the filter row (the parent of `[data-home-locate]`) → the
 *     floating chrome the fitted frame already reserves at the top.
 *   · `[data-curated-map-tab]`                     → the floating "Tempat
 *     Pilihan" tab the invite card must not cover.
 *   · `[data-home-invite-pill]`                    → the ONE no-location
 *     information board, inside the results panel above the first card.
 *
 * THE RULE LOCKED HERE (presentation only): a pin whose tip sits BELOW the
 * results panel's top edge, or ABOVE the floating chrome's bottom edge, is not
 * on the visible map — it is under the panel or under the chrome. The catalogue
 * fit reserves the chrome but, before this change, not the panel, so the whole
 * spread was centred in the full-height box and every southern pin (Indonesia)
 * landed behind the sheet. No data, camera rule, radius, tab, or tile provider
 * changes here: the SAME catalogue bounds are fitted into the visible band.
 *
 * Pins that overlap EACH OTHER (the Gulf cluster) are intentionally allowed —
 * that is a clustering question for a separate change, not a frame question.
 *
 * Tile traffic is intercepted so the run needs no live tile server.
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

/** Mock fix: Bandung, inside the Indonesian catalogue (real coordinates). */
const MOCK_FIX = { latitude: -6.9175, longitude: 107.6191 };

type TileHit = { z: number; x: number; y: number; frame: string | null };

/** Record every tile requested from navigation onwards; serve a blank PNG. */
async function captureTiles(page: Page): Promise<TileHit[]> {
  const hits: TileHit[] = [];
  await page.route(TILE_ROUTE, async (route) => {
    const url = route.request().url();
    const match = /tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/.exec(url);
    if (match) {
      const frame = await page
        .evaluate(
          () =>
            document
              .querySelector("div.singgah-home-map")
              ?.getAttribute("data-singgah-map-frame") ?? null,
        )
        .catch(() => null);
      hits.push({ z: Number(match[1]), x: Number(match[2]), y: Number(match[3]), frame });
    }
    await route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG });
  });
  return hits;
}

type PinBox = {
  label: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  centerY: number;
  centerX: number;
};
type Box = { top: number; bottom: number; left: number; right: number } | null;

type MapAudit = {
  frame: string | null;
  ready: string | null;
  viewport: { width: number; height: number };
  pins: PinBox[];
  sheetTop: number | null;
  chromeBottom: number | null;
  tab: Box;
  filter: Box;
  header: Box;
  card: Box;
  firstCardTop: number | null;
  coveredByPanel: number;
  coveredByChrome: number;
  cardPinOverlaps: number;
  cardTabOverlap: boolean;
  cardFilterOverlap: boolean;
  cardHeaderOverlap: boolean;
  cardText: string | null;
  cardButtons: number;
  cardBoards: number;
  inviteCardsInPanel: number;
  cardAbovePanel: boolean | null;
};

/** One snapshot of everything the frame decision is judged by. */
async function auditMap(page: Page): Promise<MapAudit> {
  return page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const mapEl = document.querySelector("div.singgah-home-map");
    const sheet = document.querySelector("section.singgah-sheet");
    const header = document.querySelector("header");
    const locate = document.querySelector("[data-home-locate]");
    const filterRow = locate?.parentElement ?? null;
    const tabs = mapEl ? Array.from(mapEl.querySelectorAll(".singgah-pin")) : [];
    const pins = tabs.map((el, index) => {
      const r = el.getBoundingClientRect();
      const label = el.getAttribute("aria-label") ?? `pin-${index}`;
      return {
        label,
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        centerY: r.top + r.height / 2,
        centerX: r.left + r.width / 2,
      };
    });
    const sheetRect = rect(sheet);
    const chromeBottom = Math.max(
      rect(header)?.bottom ?? 0,
      rect(filterRow)?.bottom ?? 0,
    );
    const sheetTop = sheetRect ? sheetRect.top : null;
    const tab = document.querySelector("[data-curated-map-tab]");
    const tabRect = rect(tab);
    // The board is the MAP PILL since 2026-10-29 (the in-panel card is gone).
    const cardEl = document.querySelector("[data-home-invite-pill]");
    const cardRect = rect(cardEl);
    const filterRect = rect(locate?.parentElement ?? null);
    const headerRect = rect(header);
    const firstCard = document.querySelector("[data-place-card-id]");
    const overlaps = (a: Box, b: Box) =>
      !!a && !!b && a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;
    return {
      frame: mapEl?.getAttribute("data-singgah-map-frame") ?? null,
      ready: mapEl?.getAttribute("data-singgah-map") ?? null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      pins,
      sheetTop,
      chromeBottom,
      tab:
        tabRect && getComputedStyle(tab as Element).visibility !== "hidden" ? tabRect : null,
      filter: filterRect,
      header: headerRect,
      card: cardRect,
      firstCardTop: firstCard ? firstCard.getBoundingClientRect().top : null,
      coveredByPanel:
        sheetTop === null ? 0 : pins.filter((pin) => pin.bottom > sheetTop).length,
      coveredByChrome: pins.filter((pin) => pin.top < chromeBottom).length,
      cardPinOverlaps: pins.filter((pin) => overlaps(cardRect, pin)).length,
      cardTabOverlap: overlaps(cardRect, tabRect),
      cardFilterOverlap: overlaps(cardRect, filterRect),
      cardHeaderOverlap: overlaps(cardRect, headerRect),
      cardText: cardEl ? (cardEl.textContent ?? "").replace(/\s+/g, " ").trim() : null,
      cardButtons: cardEl ? cardEl.querySelectorAll("button").length : 0,
      cardBoards: document.querySelectorAll(
        "[data-home-invite-pill], [data-home-no-location-hint]",
      ).length,
      inviteCardsInPanel: document.querySelectorAll("[data-home-invite-card]").length,
      cardAbovePanel: cardRect && sheetRect ? cardRect.bottom <= sheetRect.top : null,
    };
  });
}

/** Wait for the settled no-origin frame, then for the first viewport report. */
async function waitForCatalogueFrame(page: Page) {
  const map = page.locator("div.singgah-home-map").first();
  await expect(map).toHaveAttribute("data-singgah-map-frame", "catalogue", { timeout: 30_000 });
  await expect(map).toHaveAttribute("data-singgah-map", "ready", { timeout: 30_000 });
  // The first viewport report lands ~150 ms after `ready`; after that the marker
  // set is narrowed to the visible area and the sheet/panel have their real box.
  await page.waitForTimeout(700);
  return map;
}

if (!underNodeTestRunner) {
  if (base === "") {
    test.skip(true, "BASE_URL is not set; nothing to frame");
  }

  test.describe("home-catalogue-frame / no location", () => {
    /**
     * THE CORE RULE: with no location the map shows the whole catalogue, and
     * every one of its pins must sit on the visible band — above the results
     * panel and below the floating chrome.
     */
    test("every catalogue pin sits above the results panel", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        permissions: [], // geolocation denied — the documented no-origin view
      });
      try {
        const page = await context.newPage();
        const tiles = await captureTiles(page);
        await page.goto(base, { waitUntil: "commit" });
        await waitForCatalogueFrame(page);

        const audit = await auditMap(page);
        console.log(`[frame] ${JSON.stringify({
          frame: audit.frame,
          ready: audit.ready,
          viewport: audit.viewport,
          pins: audit.pins.length,
          sheetTop: audit.sheetTop,
          chromeBottom: audit.chromeBottom,
          coveredByPanel: audit.coveredByPanel,
          coveredByChrome: audit.coveredByChrome,
          pinBand: audit.pins.length
            ? [Math.min(...audit.pins.map((p) => p.top)), Math.max(...audit.pins.map((p) => p.bottom))]
            : null,
        })}`);

        expect(audit.pins.length, "the catalogue frame must place its pins").toBeGreaterThan(0);
        expect(
          audit.pins.filter((pin) => pin.bottom > (audit.sheetTop ?? Number.POSITIVE_INFINITY)),
          "no pin may sit behind the results panel",
        ).toEqual([]);
        expect(
          audit.pins.filter((pin) => pin.top < (audit.chromeBottom ?? 0)),
          "no pin may sit behind the floating chrome",
        ).toEqual([]);

        // ONE frame, decided before any tile: no tile while the frame is null,
        // and the catalogue fit never re-zooms afterwards.
        expect(
          tiles.filter((t) => t.frame === null).map((t) => `z${t.z}`),
          "no tile may be requested before data-singgah-map-frame is decided",
        ).toEqual([]);
        const zooms = Array.from(new Set(tiles.map((t) => t.z)));
        console.log(`[frame] tile zooms: ${JSON.stringify(zooms)} (${tiles.length} tiles)`);
        expect(zooms.length, "the catalogue frame must not re-zoom").toBeLessThanOrEqual(1);

        await page.waitForTimeout(600);
        const after = await auditMap(page);
        expect(
          tiles.filter((t) => t.frame === null).map((t) => `z${t.z}`),
          "no tile may be requested before the frame later either",
        ).toEqual([]);
        expect(
          after.pins.filter((pin) => pin.bottom > (after.sheetTop ?? Number.POSITIVE_INFINITY)),
          "the frame must stay on the visible band after settling",
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });

    /**
     * THE INVITE PILL (2026-10-29): without a location the map shows the whole
     * catalogue (not "the nearest 1 km"), so Home says so once — in ONE compact
     * pill ON THE MAP, 8px under the filter row, with the real locate action.
     * Nothing is left inside the results panel, and the first Place card is
     * back at its baseline offset.
     */
    test("the no-location pill explains the catalogue and covers nothing", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        permissions: [],
      });
      try {
        const page = await context.newPage();
        // Deterministic permission state: this test measures the card's copy
        // and layout, not the browser's remembered geolocation decision.
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "permissions", {
            configurable: true,
            get: () => ({
              query: async () => ({
                state: "prompt",
                addEventListener() {},
                removeEventListener() {},
              }),
            }),
          });
        });
        await captureTiles(page);
        await page.goto(base, { waitUntil: "commit" });
        await waitForCatalogueFrame(page);

        const card = page.locator("[data-home-invite-pill]");
        await expect(card).toBeVisible({ timeout: 15_000 });
        const audit = await auditMap(page);
        console.log(`[card] ${JSON.stringify({
          text: audit.cardText,
          buttons: audit.cardButtons,
          card: audit.card,
          sheetTop: audit.sheetTop,
          firstCardTop: audit.firstCardTop,
          tab: audit.tab,
        })}`);

        // EXACTLY ONE board over the map, warm copy, no warning language, and
        // NOTHING inside the results panel.
        expect(audit.cardBoards, "the old chip is removed").toBe(1);
        expect(audit.inviteCardsInPanel, "no in-panel invite card remains").toBe(0);
        expect(audit.cardText ?? "").toContain("Temukan terdekat");
        expect(audit.cardText ?? "").toContain("Aktifkan lokasi, peta berpusat di sekitarmu");
        expect(audit.cardText ?? "").not.toMatch(/peringatan|gagal|error|kesalahan/i);

        // The action is the EXISTING "Lokasi Saya" path, at a thumb target.
        const locate = card.locator("[data-home-invite-locate]");
        await expect(locate).toHaveCount(1);
        expect(audit.cardButtons).toBe(1);
        const buttonBox = await locate.boundingBox();
        expect(buttonBox?.height ?? 0).toBeGreaterThanOrEqual(44);

        // OVER THE MAP: the pill is a map control now, so it must sit ABOVE the
        // panel's top edge and clear every surface of the map itself.
        expect(audit.cardAbovePanel, "the pill sits above the results panel").toBe(true);
        expect(audit.cardPinOverlaps, "the pill covers no pin").toBe(0);
        expect(audit.cardTabOverlap, "the pill covers no floating tab").toBe(false);
        expect(audit.cardFilterOverlap, "the pill covers no filter control").toBe(false);
        expect(audit.cardHeaderOverlap, "the pill covers no header control").toBe(false);
        expect(
          (audit.card?.bottom ?? 0) - (audit.card?.top ?? 0),
          "the pill is at most 52px tall",
        ).toBeLessThanOrEqual(52);
        // BASELINE RESTORED (2026-10-29): the board no longer lives in the list,
        // so the first Place card moves down by nothing again — the panel's own
        // 44px handle band plus the list's 16px top padding, and no more. The
        // old ~60px in-panel-card allowance is restored to its original budget.
        const BASELINE_FIRST_CARD_PX = 44 + 16;
        expect(
          (audit.firstCardTop ?? 0) - (audit.sheetTop ?? 0),
          "the first Place card is back at its baseline offset",
        ).toBeLessThanOrEqual(BASELINE_FIRST_CARD_PX + 1);

        // Announced politely, not as an alert.
        await expect(card).toHaveAttribute("aria-live", "polite");
        await expect(card).toHaveAttribute("role", "status");
      } finally {
        await context.close();
      }
    });

    /** A real fix means the card has nothing to explain: it is gone. */
    test("the card disappears once a location is known", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        permissions: ["geolocation"],
        geolocation: { latitude: MOCK_FIX.latitude, longitude: MOCK_FIX.longitude },
      });
      try {
        const page = await context.newPage();
        await captureTiles(page);
        await page.goto(base, { waitUntil: "commit" });
        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map-frame", "origin", { timeout: 30_000 });
        await page.waitForTimeout(900);
        await expect(page.locator("[data-home-invite-pill]")).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    /**
     * NO GEOLOCATION AT ALL: the card still explains the catalogue but offers
     * no action (there is nothing to press that could work), and it must not
     * introduce a server/client render difference.
     */
    test("without geolocation the card has no button and hydrates cleanly", async ({
      browser,
    }) => {
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
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "geolocation", {
            configurable: true,
            get: () => undefined,
          });
        });
        const ssrHtml = await (await context.request.get(base)).text();
        const ssrCard = ssrHtml.includes("data-home-invite-pill");

        await captureTiles(page);
        await page.goto(base, { waitUntil: "commit" });
        await waitForCatalogueFrame(page);
        await page.waitForTimeout(600);

        const audit = await auditMap(page);
        console.log(`[card-no-geo] console messages: ${seen.length}`);
        console.log(`[card-no-geo] hydration complaints: ${JSON.stringify(hydration)}`);
        console.log(`[card-no-geo] ${JSON.stringify({
          ssrCard,
          text: audit.cardText,
          buttons: audit.cardButtons,
          hasGeolocation: await page.evaluate(() => navigator.geolocation != null),
        })}`);

        expect(hydration, "server HTML and the first client render must agree").toEqual([]);
        // The server never claims a settled location, so it renders no card.
        expect(ssrCard, "the server must not render the settled card").toBe(false);
        await expect(page.locator("[data-home-invite-pill]")).toBeVisible({ timeout: 15_000 });
        expect(audit.cardText ?? "").toContain("Peta ini menampilkan semua tempat.");
        expect(audit.cardButtons, "no control that cannot work").toBe(0);
      } finally {
        await context.close();
      }
    });
  });
}
