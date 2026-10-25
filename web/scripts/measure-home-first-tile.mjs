/**
 * MEASUREMENT ONLY (perf/map-tile-early-start).
 *
 * Times, on a LOCAL PRODUCTION BUILD (`next build` + `next start`):
 *   · `firstTileStart`  — startTime of the FIRST OSM tile request
 *                         (performance resource timing, navigation-relative);
 *   · `mapReady`        — when `data-singgah-map` becomes "ready";
 *   · `mapInitializing` — when the map effect first claims the container
 *                         (the closest observable proxy for "hydration
 *                         committed and client code is running");
 *   · `leafletChunkStart` — start of the lazy Leaflet chunk request, when the
 *                         chunk can be identified in `.next/static/chunks`.
 *
 * Conditions mirror PageSpeed mobile: 390x844 mobile viewport, Slow-4G-ish
 * CDP network (1.6 Mbps down / 750 kbps up / 150 ms RTT) and 4x CPU
 * throttling. Geolocation is run twice: granted (fixed coordinate) and denied.
 *
 * Tiles are answered locally (blank PNG) so the run needs no network; the
 * REQUEST timing that this measures is unaffected by the local response.
 *
 * Usage: BASE_URL=http://127.0.0.1:3200 RUNS=5 node scripts/measure-home-first-tile.mjs
 */
import { chromium } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3200";
const RUNS = Number(process.env.RUNS ?? 5);
/** "granted" | "denied" | "both" (default) — one mode per invocation keeps each run short. */
const MODE = process.env.MODE ?? "both";
/** "stub" (default: blank PNG, no network) | "real" (real OSM tiles, so the
 *  connection-setup cost that preconnect removes is actually paid). */
const TILES = process.env.TILES ?? "stub";
const MOCK_FIX = { latitude: -6.9175, longitude: 107.6191 };

/** 1x1 transparent PNG. */
const TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * The lazy Leaflet chunk: the built file that contains Leaflet's own marker
 * strings. Used only to label the resource entry, never to change the app.
 */
function findLeafletChunk() {
  const root = path.resolve(process.cwd(), ".next", "static", "chunks");
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".js")) {
        const text = readFileSync(full, "utf8");
        if (text.includes("leaflet") && text.includes("1.9.4")) hits.push(entry);
      }
    }
  };
  try {
    walk(root);
  } catch {
    return null;
  }
  return hits[0] ?? null;
}

async function runOnce(browser, grant) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    ...(grant
      ? { permissions: ["geolocation"], geolocation: MOCK_FIX }
      : {}),
  });
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: Math.round((1.6 * 1024 * 1024) / 8),
      uploadThroughput: Math.round((750 * 1024) / 8),
      connectionType: "cellular4g",
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

    await page.addInitScript(() => {
      const probe = { initializing: null, ready: null };
      window.__probe = probe;
      const record = () => {
        const el = document.querySelector("[data-singgah-map]");
        if (!el) return;
        const state = el.getAttribute("data-singgah-map");
        if (state === "initializing" && probe.initializing === null) {
          probe.initializing = performance.now();
        }
        if (state === "ready" && probe.ready === null) probe.ready = performance.now();
      };
      new MutationObserver(record).observe(document.documentElement ?? document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-singgah-map"],
      });
      document.addEventListener("DOMContentLoaded", record);
    });

    const tileUrls = [];
    if (TILES !== "real") {
      await page.route("**/tile.openstreetmap.org/**", async (route) => {
        tileUrls.push(route.request().url());
        await route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG });
      });
    } else {
      page.on("request", (request) => {
        if (request.url().includes("tile.openstreetmap.org/")) tileUrls.push(request.url());
      });
    }

    await page.goto(BASE, { waitUntil: "commit" });
    await page.waitForFunction(
      () =>
        document.querySelector("[data-singgah-map]")?.getAttribute("data-singgah-map") ===
        "ready",
      undefined,
      { timeout: 90_000, polling: 50 },
    );

    if (TILES === "real") {
      // Real tiles are still in flight at `ready`; wait for the first COMPLETED
      // entry so its resource timing (and the network the preconnect affects)
      // is measurable. The request start it reports is unaffected.
      await page.waitForFunction(
        () =>
          performance
            .getEntriesByType("resource")
            .some((entry) => entry.name.includes("tile.openstreetmap.org/")),
        undefined,
        { timeout: 30_000, polling: 100 },
      );
    }

    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const resources = performance.getEntriesByType("resource").map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        startTime: entry.startTime,
        responseEnd: entry.responseEnd,
      }));
      const tileEntries = resources.filter((entry) =>
        entry.name.includes("tile.openstreetmap.org/"),
      );
      return {
        nav: nav
          ? {
              ttfb: nav.responseStart,
              domContentLoaded: nav.domContentLoadedEventEnd,
              load: nav.loadEventEnd,
            }
          : null,
        tileCount: tileEntries.length,
        firstTileStart: tileEntries.length
          ? Math.min(...tileEntries.map((entry) => entry.startTime))
          : null,
        firstTileResponseEnd: tileEntries.length
          ? Math.min(...tileEntries.map((entry) => entry.responseEnd))
          : null,
        firstTileDuration: tileEntries.length
          ? Math.min(...tileEntries.map((entry) => entry.responseEnd - entry.startTime))
          : null,
        mapInitializing: window.__probe?.initializing ?? null,
        mapReady: window.__probe?.ready ?? null,
        resources,
      };
    });

    const leafletChunk = findLeafletChunk();
    const leafletEntry = leafletChunk
      ? metrics.resources.find((entry) => entry.name.includes(leafletChunk))
      : null;
    const scripts = metrics.resources.filter((entry) => entry.initiatorType === "script");
    return {
      leafletChunk,
      leafletChunkStart: leafletEntry ? leafletEntry.startTime : null,
      leafletChunkEnd: leafletEntry ? leafletEntry.responseEnd : null,
      lastScriptEnd: scripts.length ? Math.max(...scripts.map((s) => s.responseEnd)) : null,
      scriptCount: scripts.length,
      frame: await page
        .locator("div.singgah-home-map")
        .first()
        .getAttribute("data-singgah-map-frame"),
      tileUrls,
      ...metrics,
    };
  } finally {
    await context.close();
  }
}

function median(values) {
  const usable = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const round = (value) => (value === null ? null : Math.round(value));

const browser = await chromium.launch();
try {
  for (const grant of [true, false].filter(
    (value) => MODE === "both" || (MODE === "granted" ? value : !value),
  )) {
    const runs = [];
    for (let i = 0; i < RUNS; i += 1) {
      const result = await runOnce(browser, grant);
      runs.push(result);
      console.log(
        `[${grant ? "granted" : "denied"} #${i + 1}] frame=${result.frame} tiles=${result.tileCount} ` +
          `firstTileStart=${round(result.firstTileStart)} mapInitializing=${round(result.mapInitializing)} ` +
          `mapReady=${round(result.mapReady)} leafletStart=${round(result.leafletChunkStart)} ` +
          `leafletEnd=${round(result.leafletChunkEnd)} ` +
          `lastScriptEnd=${round(result.lastScriptEnd)} ttfb=${round(result.nav?.ttfb)}`,
      );
    }
    const summary = {
      mode: grant ? "granted" : "denied",
      runs: runs.length,
      tileCountMedian: median(runs.map((run) => run.tileCount)),
      ttfb: round(median(runs.map((run) => run.nav?.ttfb))),
      firstTileStart: round(median(runs.map((run) => run.firstTileStart))),
      firstTileResponseEnd: round(median(runs.map((run) => run.firstTileResponseEnd))),
      firstTileDuration: round(median(runs.map((run) => run.firstTileDuration))),
      mapInitializing: round(median(runs.map((run) => run.mapInitializing))),
      mapReady: round(median(runs.map((run) => run.mapReady))),
      leafletChunk: runs[0].leafletChunk,
      leafletChunkStart: round(median(runs.map((run) => run.leafletChunkStart))),
      leafletChunkEnd: round(median(runs.map((run) => run.leafletChunkEnd))),
      lastScriptEnd: round(median(runs.map((run) => run.lastScriptEnd))),
      frames: runs.map((run) => run.frame),
      rawFirstTileStart: runs.map((run) => round(run.firstTileStart)),
    };
    console.log(`MEDIAN ${JSON.stringify(summary)}`);
  }
} finally {
  await browser.close();
}
