import { test, expect, type Page } from "@playwright/test";

/**
 * WORLD-SCALE PIN SCALE + LOCATION INVITE CARD (2026-10-26).
 *
 * Focus: the HOME frame at a WIDE map scale (the no-location catalogue frame,
 * `data-singgah-map-frame="catalogue"`), measured at 390×844 with geolocation
 * denied and the basemap intercepted so the run needs no live tile server.
 *
 * What this spec measures and locks:
 *   1. PIN SCALE — on a wide frame every Place pin paints SMALL
 *      (`.singgah-pin-art` ≈ 50–60 % of its normal box) and NO name chip is
 *      painted (`data-label-state="always"` count = 0), while the transparent
 *      40×44 tap pad and every marker's identity are untouched.
 *   2. NORMAL SCALE — a granted 1 km preset (z ≈ 13–14) keeps the full-size pin
 *      and the normal painted chips, with no invite card.
 *   3. THE THRESHOLD IS THE LEAFLET ZOOM, not the frame: one wheel step across
 *      it flips `data-pin-scale` on the CONTAINER while the marker elements
 *      themselves are never rebuilt (same nodes).
 *   4. A pin tap still selects its card, and the SELECTED pin paints normal and
 *      labelled even on a compact frame; a LIVE pin keeps its readable badge.
 *   5. THE INVITE CARD (`[data-home-invite-card]`) is the ONLY information
 *      board, sits inside the results panel above the first card (the measured
 *      65px map band cannot hold the required copy), and covers no pin, filter
 *      row, tab, header, or panel top edge. It moves the first card by ≤60px.
 *   6. It is permission-aware: prompt offers `Aktifkan lokasi` and really asks;
 *      denied offers `Cara mengaktifkan`, shows steps, and never calls
 *      `getCurrentPosition`; a live change to granted asks exactly once and
 *      centres the map without a global frame.
 *   7. With no geolocation it renders its honest copy, no button, and no
 *      hydration mismatch.
 *   8. The invite card and the viewport empty-state overlay are exclusive.
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
/**
 * A coherent local area for the permission-change camera check. The Bandung
 * fixture is fine for the initial preset, but one DEV demo row is stored under
 * an SA region, so the LOCAL-AREA fit around Bandung legitimately spans the
 * Gulf and Java. Riyadh's ten fixtures are one coherent area.
 */
const RIYADH_FIX = { latitude: 24.7136, longitude: 46.6753 };

const INVITE_CARD = "[data-home-invite-card]";
const INVITE_LOCATE = "[data-home-invite-locate]";
const INVITE_HELP_TOGGLE = "[data-home-invite-help-toggle]";
const INVITE_HELP = "[data-home-invite-help]";

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

/**
 * A controllable Permissions API. `window.__permission.set(state)` fires the
 * real `change` event listeners, exactly like Chrome's own permission UI does.
 */
async function stubPermission(page: Page, initial: "prompt" | "denied" | "granted") {
  await page.addInitScript((state) => {
    const status = {
      state: state as "prompt" | "denied" | "granted",
      listeners: new Set<() => void>(),
      addEventListener(type: string, listener: () => void) {
        if (type === "change") this.listeners.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        if (type === "change") this.listeners.delete(listener);
      },
      set(next: "prompt" | "denied" | "granted") {
        this.state = next;
        this.listeners.forEach((listener) => listener());
      },
    };
    const w = window as unknown as { __permission?: typeof status };
    w.__permission = status;
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      get: () => ({
        query: async (descriptor: { name: string }) =>
          descriptor.name === "geolocation"
            ? status
            : { state: "prompt", addEventListener() {}, removeEventListener() {} },
      }),
    });
  }, initial);
}

/** Serve every basemap request locally and record the zooms requested. */
async function captureTiles(page: Page): Promise<{ z: number; frame: string | null }[]> {
  const hits: { z: number; frame: string | null }[] = [];
  await page.route(TILE_ROUTE, async (route) => {
    const url = route.request().url();
    const match = /tile\.openstreetmap\.org\/(\d+)\/\d+\/\d+\.png/.exec(url);
    if (match) {
      const frame = await page
        .evaluate(
          () =>
            document
              .querySelector("div.singgah-home-map")
              ?.getAttribute("data-singgah-map-frame") ?? null,
        )
        .catch(() => null);
      hits.push({ z: Number(match[1]), frame });
    }
    await route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG });
  });
  return hits;
}

async function blockTiles(page: Page) {
  await page.route(TILE_ROUTE, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG }),
  );
}

type PinProbe = {
  frame: string | null;
  ready: string | null;
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
      ready: container?.getAttribute("data-singgah-map") ?? null,
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
      return {
        top: b.top,
        bottom: b.bottom,
        left: b.left,
        right: b.right,
        w: Math.round(b.width * 10) / 10,
        h: Math.round(b.height * 10) / 10,
      };
    };
    const hits = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
      !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const card = document.querySelector("[data-home-invite-card]");
    const cardBox = box(card);
    const pinBoxes = [...document.querySelectorAll(".singgah-home-map .singgah-pin")].map(box);
    const tab = box(document.querySelector("[data-curated-map-tab]"));
    const sheet = box(document.querySelector("section.singgah-sheet"));
    const filter = box(document.querySelector("[data-home-locate]")?.parentElement ?? null);
    const nav = document.querySelector('nav[aria-label="Navigasi utama"]');
    const header = box(nav?.closest("header") ?? nav?.parentElement?.parentElement ?? null);
    const firstCard = box(document.querySelector("[data-place-card-id]"));
    const locate = card?.querySelector("[data-home-invite-locate]") as HTMLElement | null;
    const helpToggle = card?.querySelector("[data-home-invite-help-toggle]") as HTMLElement | null;
    const reload = card?.querySelector("[data-home-invite-reload]") as HTMLElement | null;
    const emptyOverlay = [...document.querySelectorAll("section div")].some((el) =>
      /Geser peta dengan dua jari untuk melihat area lain\./.test(el.textContent ?? ""),
    );
    return {
      card: cardBox,
      role: card?.getAttribute("role") ?? null,
      ariaLive: card?.getAttribute("aria-live") ?? null,
      insidePanel: !!cardBox && !!sheet ? cardBox.top >= sheet.top : null,
      panelTopEdgeCovered: !!cardBox && !!sheet ? cardBox.top < sheet.top : null,
      pins: pinBoxes.length,
      pinOverlaps: cardBox ? pinBoxes.filter((b) => hits(cardBox, b)).length : null,
      tabOverlap: hits(cardBox, tab),
      filterOverlap: hits(cardBox, filter),
      headerOverlap: hits(cardBox, header),
      sheetTop: sheet?.top ?? null,
      sheetBottom: sheet?.bottom ?? null,
      firstCardTop: firstCard?.top ?? null,
      cardToFirstCardGap:
        cardBox && firstCard ? Math.round((firstCard.top - cardBox.bottom) * 10) / 10 : null,
      cardPointer: card ? getComputedStyle(card).pointerEvents : null,
      text: (card as HTMLElement | null)?.innerText ?? null,
      buttons: card?.querySelectorAll("button").length ?? 0,
      locate: locate
        ? {
            text: locate.innerText.trim(),
            height: Math.round(locate.getBoundingClientRect().height),
          }
        : null,
      helpToggle: helpToggle
        ? {
            text: helpToggle.innerText.trim(),
            height: Math.round(helpToggle.getBoundingClientRect().height),
            expanded: helpToggle.getAttribute("aria-expanded"),
          }
        : null,
      helpVisible: !!document.querySelector("[data-home-invite-help]"),
      reload: reload
        ? {
            text: reload.innerText.trim(),
            height: Math.round(reload.getBoundingClientRect().height),
          }
        : null,
      emptyOverlay,
    };
  });

/** Count of real getCurrentPosition calls made by the app so far. */
const geoCallCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __geoCalls?: number }).__geoCalls ?? 0);

/** Install a counting geolocation stub that denies EVERY call (no fix ever). */
async function stubGeolocationDeniedAlways(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __geoCalls?: number };
    w.__geoCalls = 0;
    const geo = navigator.geolocation;
    if (!geo) return;
    geo.getCurrentPosition = (_ok, err) => {
      w.__geoCalls = (w.__geoCalls ?? 0) + 1;
      setTimeout(() => err?.({ code: 1, message: "denied" } as GeolocationPositionError), 300);
    };
  });
}

/** Install a counting geolocation stub that denies the FIRST call only. */
async function stubGeolocationCalls(page: Page, fix = MOCK_FIX) {
  await page.addInitScript((coords) => {
    const w = window as unknown as { __geoCalls?: number };
    w.__geoCalls = 0;
    const geo = navigator.geolocation;
    if (!geo) return;
    geo.getCurrentPosition = (ok, err) => {
      w.__geoCalls = (w.__geoCalls ?? 0) + 1;
      if (w.__geoCalls === 1) {
        setTimeout(() => err?.({ code: 1, message: "denied" } as GeolocationPositionError), 400);
        return;
      }
      setTimeout(
        () =>
          ok?.({
            coords: { latitude: coords.latitude, longitude: coords.longitude, accuracy: 20 },
          } as GeolocationPosition),
        80,
      );
    };
  }, fix);
}

if (!underNodeTestRunner) {
  if (base === "") {
    test.skip(true, "BASE_URL is not set; nothing to frame");
  }

  test.describe("home world pins / invite card (390×844)", () => {
    /** (a) THE COMPACT FRAME — pin size, chips, and the ONE information board. */
    test("a) the catalogue frame paints compact pins, no chips, and one non-covering card", async ({
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
        await expect(map).toHaveAttribute("data-singgah-map", "ready", { timeout: 25_000 });
        await expect(page.locator(INVITE_CARD)).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(500);

        const probe = await readPins(page);
        console.log(`[a] catalogue probe: ${JSON.stringify(probe)}`);
        expect(probe.frame).toBe("catalogue");
        expect(probe.pins, "the whole catalogue must be pinned").toBeGreaterThan(10);
        expect(probe.scale, "a wide frame must switch the container to compact").toBe("compact");
        expect(probe.art?.h, "the compact pin is ~55% of the 31px artwork").toBeLessThanOrEqual(20);
        expect(probe.art?.h, "the compact pin must stay visible").toBeGreaterThanOrEqual(14);
        expect(probe.paintedLabels, "no name chip may be painted on a wide frame").toBe(0);
        expect(probe.hit?.w, "the tap pad stays 40px wide").toBeGreaterThanOrEqual(40);
        expect(probe.hit?.h, "the tap pad stays 44px tall").toBeGreaterThanOrEqual(44);
        expect(probe.maxTileZoom ?? 99, "the catalogue frame is world scale").toBeLessThanOrEqual(3);

        // EXACTLY ONE board: the old floating chip is gone.
        expect(await page.locator(INVITE_CARD).count(), "one invite card").toBe(1);
        expect(
          await page.locator("[data-home-no-location-hint]").count(),
          "the old hint chip must be gone",
        ).toBe(0);

        const geo = await readCardGeometry(page);
        console.log(`[a] card geometry: ${JSON.stringify(geo)}`);
        expect(geo.card, "the card has a real box").not.toBeNull();
        expect(geo.role).toBe("status");
        expect(geo.ariaLive).toBe("polite");
        expect(geo.insidePanel, "the measured fallback is inside the results panel").toBe(true);
        expect(geo.panelTopEdgeCovered, "the card never crosses the panel's top edge").toBe(false);
        expect(geo.pinOverlaps, "the card covers no pin").toBe(0);
        expect(geo.tabOverlap, "the card covers no 'Tempat Pilihan' tab").toBe(false);
        expect(geo.filterOverlap, "the card covers no filter-row control").toBe(false);
        expect(geo.headerOverlap, "the card covers no header control").toBe(false);
        expect(geo.cardToFirstCardGap, "the card sits directly above the first card").toBeGreaterThanOrEqual(0);
        expect(geo.cardToFirstCardGap, "the card sits directly above the first card").toBeLessThanOrEqual(4);
        expect(geo.card!.h, "the first card moves by ~60px, not more").toBeLessThanOrEqual(60);
        expect(geo.cardPointer, "the card itself opts into pointer events").toBe("auto");
        expect(geo.text ?? "", "warm title").toContain("Jelajahi semua tempat");
        expect(geo.text ?? "", "the prompt variant offers the nearby places").toContain(
          "Aktifkan lokasi untuk melihat yang paling dekat denganmu",
        );
        expect(geo.locate?.text, "the prompt action is explicit").toBe("Aktifkan lokasi");
        expect(geo.locate?.height, "the primary action is a thumb target").toBeGreaterThanOrEqual(44);
        expect(geo.emptyOverlay, "the empty state is not up").toBe(false);
      } finally {
        await context.close();
      }
    });

    /** (c) THE NORMAL FRAME — a granted 1 km preset keeps normal pins + chips. */
    test("c) a granted 1 km frame keeps normal pins, chips, and no card", async ({ browser }) => {
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
        await expect(map).toHaveAttribute("data-singgah-map-frame", "origin", { timeout: 25_000 });
        await page.waitForTimeout(700);

        const probe = await readPins(page);
        console.log(`[c] origin probe: ${JSON.stringify(probe)}`);
        console.log(`[c] tile zooms: ${JSON.stringify(tiles.map((tile) => tile.z))}`);
        expect(probe.scale, "a close frame must be normal").toBe("normal");
        expect(probe.art?.h, "the normal pin is the full 31px artwork").toBeGreaterThanOrEqual(30);
        expect(probe.paintedLabels, "a close frame paints its chips").toBeGreaterThan(0);
        expect(probe.maxTileZoom ?? 0, "the 1 km preset is a close frame").toBeGreaterThanOrEqual(13);
        expect(probe.hit?.w).toBeGreaterThanOrEqual(40);
        expect(probe.hit?.h).toBeGreaterThanOrEqual(44);
        expect(await page.locator(INVITE_CARD).count(), "no card once a fix exists").toBe(0);
        await expect(page.getByRole("button", { name: "1 km", exact: true })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        expect(
          tiles.filter((tile) => tile.z <= 5).map((tile) => `z${tile.z}`),
          "no world-scale tile on an origin frame",
        ).toEqual([]);
        expect(
          tiles.filter((tile) => tile.frame === null).map((tile) => `z${tile.z}`),
          "no tile may be requested before data-singgah-map-frame is decided",
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });

    /** (b1) THE THRESHOLD IS THE ZOOM — crossing it never rebuilds a marker. */
    test("b1) a wheel across the threshold flips the scale without rebuilding markers", async ({
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
        await page.waitForTimeout(700);

        await page.mouse.move(195, 300);
        const track: { zoom: number | null; scale: string | null; markers: number }[] = [];
        let flippedAt: number | null = null;
        for (let step = 0; step < 9; step += 1) {
          const probe = await readPins(page);
          track.push({ zoom: probe.maxTileZoom, scale: probe.scale, markers: probe.markers });
          if (probe.scale === "compact") {
            flippedAt = probe.maxTileZoom;
            break;
          }
          await page.mouse.wheel(0, 60);
          await page.waitForTimeout(700);
        }
        console.log(`[b1] zoom track: ${JSON.stringify(track)}`);
        expect(flippedAt, "zooming out must reach the compact scale").not.toBeNull();
        expect(flippedAt!, "the compact band covers the country/Gulf scale").toBeGreaterThanOrEqual(7);
        expect(flippedAt!, "the threshold stays above the city scale").toBeLessThanOrEqual(11);

        const tagged = await page.evaluate(() => {
          const nodes = [...document.querySelectorAll(".singgah-map-marker")];
          nodes.forEach((node) => {
            (node as unknown as { __pinProbe?: number }).__pinProbe = 1;
          });
          return nodes.length;
        });
        await page.mouse.wheel(0, 60);
        await page.waitForTimeout(800);
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
          `[b1] after the flip: ${JSON.stringify({ tagged, after: { scale: after.scale, zoom: after.maxTileZoom, markers: after.markers }, identity })}`,
        );
        expect(identity.tagged, "the SAME marker nodes must survive the flip").toBe(tagged);
        expect(identity.total, "the marker count must not move with the scale").toBe(tagged);
        expect(after.scale).toBe("compact");
        expect(after.paintedLabels, "the compact zoom paints no chip").toBe(0);
        expect(after.hit?.w).toBeGreaterThanOrEqual(40);
        expect(after.hit?.h).toBeGreaterThanOrEqual(44);
      } finally {
        await context.close();
      }
    });

    /** (b2) A PIN TAP — selection, and a SELECTED pin that is normal + labelled. */
    test("b2) tapping a pin still selects its card and the selected pin paints normal", async ({
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
        await page.waitForTimeout(800);

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
        await page.waitForTimeout(1_100);

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
        console.log(`[b2] after the pin tap: ${JSON.stringify(state)}`);
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

    /** (b3) LIVE STAYS READABLE at the compact scale. */
    test("b3) a LIVE pin keeps a readable badge on the compact frame", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await blockTiles(page);
        await denyGeolocation(page);
        await page.route("**/api/live/discovery", (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              live: [
                {
                  sessionId: "live-fixture-1",
                  placeId: "bakso-migran",
                  placeName: "Bakso Migran",
                  placeArea: "Manama",
                  stageId: null,
                  processTitle: null,
                  startedAt: new Date().toISOString(),
                  viewerPeak: 1,
                  position: null,
                  latitude: 26.3642121,
                  longitude: 50.1988771,
                },
              ],
            }),
          }),
        );
        await page.goto(base, { waitUntil: "commit" });
        await expect(page.locator("div.singgah-home-map").first()).toHaveAttribute(
          "data-singgah-map-frame",
          "catalogue",
          { timeout: 25_000 },
        );
        await page.getByRole("button", { name: "LIVE", exact: true }).click();

        const livePin = page.locator(".singgah-home-map .singgah-pin--live").first();
        await expect(livePin).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(300);

        const state = await page.evaluate(() => {
          const pin = document.querySelector(".singgah-home-map .singgah-pin--live");
          const badge = pin?.querySelector(".singgah-pin-badge") as HTMLElement | null;
          const art = pin?.querySelector(".singgah-pin-art") as HTMLElement | null;
          return {
            scale: document.querySelector("div.singgah-home-map")?.getAttribute("data-pin-scale"),
            badgeText: badge?.innerText.trim() ?? null,
            badgeFont: badge ? getComputedStyle(badge).fontSize : null,
            badgeVisible: badge ? getComputedStyle(badge).visibility : null,
            artH: art ? art.getBoundingClientRect().height : null,
          };
        });
        console.log(`[b3] live pin: ${JSON.stringify(state)}`);
        expect(state.scale, "LIVE is measured on the compact frame").toBe("compact");
        expect(state.badgeText, "the LIVE status stays readable").toBe("LIVE");
        expect(state.badgeFont, "the badge keeps its full 9px type").toBe("9px");
        expect(state.badgeVisible).toBe("visible");
        expect(state.artH, "the pin itself is compact").toBeLessThanOrEqual(20);
      } finally {
        await context.close();
      }
    });

    /** (d) NO GEOLOCATION — honest copy, no action, clean hydration. */
    test("d) without geolocation the card explains the frame, offers no action, and hydrates cleanly", async ({
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
        const ssrHtml = await (await context.request.get(base)).text();
        await blockTiles(page);
        await page.goto(base, { waitUntil: "commit" });

        const map = page.locator("div.singgah-home-map").first();
        await expect(map).toHaveAttribute("data-singgah-map-frame", "catalogue", { timeout: 25_000 });
        await page.waitForTimeout(1_200);

        const state = await readCardGeometry(page);
        console.log(`[d] no-geolocation card: ${JSON.stringify(state)}`);
        console.log(`[d] hydration complaints: ${JSON.stringify(hydration)}`);
        expect(ssrHtml.includes("data-home-invite-card"), "the server renders no settled card").toBe(
          false,
        );
        expect(state.card, "the card still explains the frame").not.toBeNull();
        expect(state.buttons, "no location action for a browser without geolocation").toBe(0);
        expect(state.text ?? "").toContain("Jelajahi semua tempat");
        expect(state.text ?? "").toContain("Peta ini menampilkan semua tempat.");
        expect(state.text ?? "").not.toContain("Aktifkan lokasi untuk");
        expect(state.pinOverlaps, "the card still covers no pin").toBe(0);
        expect(state.insidePanel, "the card stays inside the panel").toBe(true);
        expect(hydration, "server HTML and the first client render must agree").toEqual([]);
      } finally {
        await context.close();
      }
    });

    /** (e1) PROMPT — the action really asks the browser for a location. */
    test("e1) prompt offers 'Aktifkan lokasi' and the press asks for a fix", async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await blockTiles(page);
        await stubPermission(page, "prompt");
        await stubGeolocationDeniedAlways(page);
        await page.goto(base, { waitUntil: "commit" });

        await expect(page.locator("div.singgah-home-map").first()).toHaveAttribute(
          "data-singgah-map-frame",
          "catalogue",
          { timeout: 25_000 },
        );
        await expect(page.locator(INVITE_CARD)).toBeVisible({ timeout: 15_000 });
        const card = await readCardGeometry(page);
        console.log(`[e1] prompt card: ${JSON.stringify({ locate: card.locate, helpToggle: card.helpToggle })}`);
        expect(card.locate?.text).toBe("Aktifkan lokasi");
        expect(card.helpToggle).toBeNull();

        const before = await geoCallCount(page);
        await page.locator(INVITE_LOCATE).click();
        await page.waitForTimeout(700);
        const after = await geoCallCount(page);
        console.log(`[e1] geolocation calls before=${before} after=${after}`);
        expect(after, "the button must trigger a fresh geolocation request").toBe(before + 1);
        await expect(page.locator(INVITE_CARD)).toBeVisible();
      } finally {
        await context.close();
      }
    });

    /** (e2) DENIED — inform, never call getCurrentPosition, offer a reload. */
    test("e2) denied offers 'Cara mengaktifkan', shows steps, and never requests a fix", async ({
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
        await stubPermission(page, "denied");
        await stubGeolocationCalls(page);
        await page.goto(base, { waitUntil: "commit" });

        await expect(page.locator("div.singgah-home-map").first()).toHaveAttribute(
          "data-singgah-map-frame",
          "catalogue",
          { timeout: 25_000 },
        );
        await expect(page.locator(INVITE_CARD)).toBeVisible({ timeout: 15_000 });
        const before = await geoCallCount(page);
        const card = await readCardGeometry(page);
        console.log(`[e2] denied card: ${JSON.stringify({ locate: card.locate, helpToggle: card.helpToggle })}`);
        expect(card.locate, "a denied permission must not promise a prompt").toBeNull();
        expect(card.helpToggle?.text).toBe("Cara mengaktifkan");
        expect(card.helpToggle?.height).toBeGreaterThanOrEqual(44);
        expect(card.helpVisible).toBe(false);

        await page.locator(INVITE_HELP_TOGGLE).click();
        await expect(page.locator(INVITE_HELP)).toBeVisible();
        const help = await readCardGeometry(page);
        console.log(
          `[e2] denied help: ${JSON.stringify({ helpVisible: help.helpVisible, reload: help.reload, text: help.text })}`,
        );
        expect(help.text ?? "").toMatch(/Chrome di Android/);
        expect(help.text ?? "").toMatch(/gembok/i);
        expect(help.text ?? "").toMatch(/Izin/);
        expect(help.text ?? "").toMatch(/Lokasi/);
        expect(help.text ?? "").toMatch(/Izinkan/);
        expect(help.reload?.text).toBe("Muat ulang halaman");
        expect(help.reload?.height).toBeGreaterThanOrEqual(44);
        const after = await geoCallCount(page);
        expect(after, "a denied press must not call getCurrentPosition").toBe(before);
        await expect(page.locator(INVITE_CARD)).toBeVisible();
      } finally {
        await context.close();
      }
    });

    /** (e3) GRANTED VIA THE BROWSER — one new request, centred, card gone. */
    test("e3) a change to granted requests the fix exactly once and centres the map", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        const tiles = await captureTiles(page);
        await stubPermission(page, "prompt");
        await stubGeolocationCalls(page, RIYADH_FIX);
        await page.goto(base, { waitUntil: "commit" });

        await expect(page.locator("div.singgah-home-map").first()).toHaveAttribute(
          "data-singgah-map-frame",
          "catalogue",
          { timeout: 25_000 },
        );
        await expect(page.locator(INVITE_CARD)).toBeVisible({ timeout: 15_000 });
        const before = await geoCallCount(page);
        const worldTilesBefore = tiles.filter((tile) => tile.z <= 5).length;
        console.log(`[e3] before granting: calls=${before} worldTiles=${worldTilesBefore}`);

        await page.evaluate(() => {
          (window as unknown as { __permission: { set(state: string): void } }).__permission.set(
            "granted",
          );
        });
        await expect(page.locator(INVITE_CARD)).toHaveCount(0, { timeout: 15_000 });

        const after = await geoCallCount(page);
        console.log(`[e3] after granting: calls=${after} tiles=${JSON.stringify(tiles.map((tile) => tile.z))}`);
        expect(after, "the granted change requests the fix exactly once").toBe(before + 1);
        await page.waitForTimeout(600);
        expect(await geoCallCount(page), "no duplicate follow-up request").toBe(after);
        await expect
          .poll(async () => (await readPins(page)).maxTileZoom ?? 0, { timeout: 10_000 })
          .toBeGreaterThanOrEqual(10);
        const probe = await readPins(page);
        console.log(
          `[e3] camera after granting: ${JSON.stringify({ frame: probe.frame, zoom: probe.maxTileZoom, scale: probe.scale, zooms: probe.tileZooms, pins: probe.pins, locateArea: await page.locator(".singgah-locate-area").count(), tab1km: await page.getByRole("button", { name: "1 km", exact: true }).getAttribute("aria-pressed") })}`,
        );
        expect(probe.scale, "the centred frame is no longer world-scale").toBe("normal");
        expect(
          tiles.filter((tile) => tile.z <= 5).length,
          "no new global frame may be introduced",
        ).toBe(worldTilesBefore);
        expect(probe.frame, "the initial frame attribute is unchanged").toBe("catalogue");
      } finally {
        await context.close();
      }
    });

    /** (e4) NO PERMISSIONS API — the previous locate behavior is preserved. */
    test("e4) without the Permissions API the card keeps the previous locate action", async ({
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
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "permissions", {
            configurable: true,
            get: () => undefined,
          });
        });
        await stubGeolocationCalls(page);
        await page.goto(base, { waitUntil: "commit" });

        await expect(page.locator("div.singgah-home-map").first()).toHaveAttribute(
          "data-singgah-map-frame",
          "catalogue",
          { timeout: 25_000 },
        );
        await expect(page.locator(INVITE_CARD)).toBeVisible({ timeout: 15_000 });
        const card = await readCardGeometry(page);
        console.log(`[e4] no permissions API: ${JSON.stringify({ locate: card.locate, helpToggle: card.helpToggle })}`);
        expect(card.locate?.text).toBe("Aktifkan lokasi");
        expect(card.helpToggle).toBeNull();
        const before = await geoCallCount(page);
        await page.locator(INVITE_LOCATE).click();
        await page.waitForTimeout(600);
        expect(await geoCallCount(page), "the old locate path still runs").toBe(before + 1);
      } finally {
        await context.close();
      }
    });

    /** (8) MUTUAL EXCLUSION with the viewport empty-state overlay. */
    test("h) the invite card and the empty-state overlay never show together", async ({ browser }) => {
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

        await expect(page.locator("div.singgah-home-map").first()).toHaveAttribute(
          "data-singgah-map-frame",
          "catalogue",
          { timeout: 25_000 },
        );
        await expect(page.locator(INVITE_CARD)).toBeVisible({ timeout: 15_000 });
        const emptyOverlay = page.getByText("Geser peta dengan dua jari untuk melihat area lain.", {
          exact: false,
        });
        expect(await emptyOverlay.count(), "no empty state while the catalogue is framed").toBe(0);

        // Zoom into an empty stretch of ocean: the viewport report flips the
        // honest empty state on, and the invite card must leave with it.
        await page.mouse.move(45, 260);
        for (let step = 0; step < 5; step += 1) {
          await page.mouse.wheel(0, -60);
          await page.waitForTimeout(800);
          if ((await emptyOverlay.count()) > 0) break;
        }
        const emptyCount = await emptyOverlay.count();
        const cardCount = await page.locator(INVITE_CARD).count();
        console.log(`[h] empty viewport: empty=${emptyCount} card=${cardCount}`);
        expect(emptyCount, "the empty state must appear").toBeGreaterThan(0);
        expect(cardCount, "the invite card must leave while the empty state is up").toBe(0);

        // Zooming back out restores the populated frame and the card.
        for (let step = 0; step < 6; step += 1) {
          await page.mouse.wheel(0, 60);
          await page.waitForTimeout(700);
          if ((await page.locator(INVITE_CARD).count()) > 0) break;
        }
        expect(await page.locator(INVITE_CARD).count(), "the card returns").toBe(1);
        expect(await emptyOverlay.count(), "the empty state left").toBe(0);
      } finally {
        await context.close();
      }
    });
  });
}
