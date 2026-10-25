/**
 * MEASUREMENT ONLY (perf/home-js-hydration).
 *
 * Times the first map tile against the JavaScript that has to run before it can
 * be requested, on a LOCAL PRODUCTION BUILD (`next build` + `next start`):
 *
 *   · `firstTileStart`   — startTime of the FIRST OSM tile request;
 *   · `mapInitializing`  — when the map effect first claims the container (the
 *                          closest observable proxy for "client code is running");
 *   · `mapReady`         — when `data-singgah-map` becomes "ready" (frame set);
 *   · `scriptDuration`   — main-thread script time (CDP Performance.ScriptDuration);
 *   · `totalJsDecoded`   — sum of decodedBodySize over script resources, i.e. the
 *                          JS the browser actually parses/executes.
 *
 * Conditions mirror PageSpeed mobile: 390x844 mobile viewport, Slow-4G-ish CDP
 * network (1.6 Mbps down / 750 kbps up / 150 ms RTT) and 4x CPU throttling.
 * Geolocation is measured twice: granted (fixed coordinate) and denied.
 *
 * Tiles are answered locally (blank PNG) so the run needs no network; the
 * REQUEST timing this measures is unaffected by the local response.
 *
 * Usage: BASE_URL=http://127.0.0.1:3300 RUNS=8 node scripts/measure-home-js.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3300";
const RUNS = Number(process.env.RUNS ?? 8);
/** "granted" | "denied" | "both" (default). */
const MODE = process.env.MODE ?? "both";
const MOCK_FIX = { latitude: -6.9175, longitude: 107.6191 };

/** 1x1 transparent PNG. */
const TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function runOnce(browser, grant) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    ...(grant ? { permissions: ["geolocation"], geolocation: MOCK_FIX } : {}),
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
    await cdp.send("Performance.enable");

    await page.addInitScript(() => {
      const probe = { initializing: null, ready: null, frame: null };
      window.__probe = probe;
      const record = () => {
        const el = document.querySelector("[data-singgah-map]");
        if (!el) return;
        const state = el.getAttribute("data-singgah-map");
        if (state === "initializing" && probe.initializing === null) {
          probe.initializing = performance.now();
        }
        if (state === "ready" && probe.ready === null) probe.ready = performance.now();
        const frame = el.getAttribute("data-singgah-map-frame");
        if (frame && probe.frame === null) probe.frame = performance.now();
      };
      new MutationObserver(record).observe(document.documentElement ?? document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-singgah-map", "data-singgah-map-frame"],
      });
      document.addEventListener("DOMContentLoaded", record);
    });

    const tileUrls = [];
    await page.route("**/tile.openstreetmap.org/**", async (route) => {
      tileUrls.push(route.request().url());
      await route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG });
    });

    await page.goto(BASE, { waitUntil: "commit" });
    await page.waitForFunction(
      () =>
        document.querySelector("[data-singgah-map]")?.getAttribute("data-singgah-map") ===
        "ready",
      undefined,
      { timeout: 90_000, polling: 50 },
    );

    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const resources = performance.getEntriesByType("resource").map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        startTime: entry.startTime,
        responseEnd: entry.responseEnd,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
      }));
      const tiles = resources.filter((entry) => entry.name.includes("tile.openstreetmap.org/"));
      const scripts = resources.filter((entry) => entry.initiatorType === "script");
      const sum = (list, key) => list.reduce((total, entry) => total + (entry[key] || 0), 0);
      return {
        nav: nav
          ? {
              ttfb: nav.responseStart,
              domContentLoaded: nav.domContentLoadedEventEnd,
              load: nav.loadEventEnd,
            }
          : null,
        tileCount: tiles.length,
        firstTileStart: tiles.length ? Math.min(...tiles.map((entry) => entry.startTime)) : null,
        firstTileResponseEnd: tiles.length
          ? Math.min(...tiles.map((entry) => entry.responseEnd))
          : null,
        scriptCount: scripts.length,
        lastScriptEnd: scripts.length ? Math.max(...scripts.map((s) => s.responseEnd)) : null,
        totalJsTransfer: sum(scripts, "transferSize"),
        totalJsEncoded: sum(scripts, "encodedBodySize"),
        totalJsDecoded: sum(scripts, "decodedBodySize"),
        topScripts: scripts
          .map((entry) => ({
            name: entry.name.replace(/^https?:\/\/[^/]+/, ""),
            decoded: entry.decodedBodySize,
            start: Math.round(entry.startTime),
            end: Math.round(entry.responseEnd),
          }))
          .sort((a, b) => b.decoded - a.decoded),
        mapInitializing: window.__probe?.initializing ?? null,
        mapReady: window.__probe?.ready ?? null,
        frameAt: window.__probe?.frame ?? null,
      };
    });

    const perfMetrics = await cdp.send("Performance.getMetrics");
    const metric = (name) => {
      const found = perfMetrics.metrics.find((entry) => entry.name === name);
      return found ? found.value : null;
    };

    return {
      ...metrics,
      frame: await page
        .locator("div.singgah-home-map")
        .first()
        .getAttribute("data-singgah-map-frame"),
      tileUrls,
      scriptDurationMs: metric("ScriptDuration") === null ? null : metric("ScriptDuration") * 1000,
      taskDurationMs: metric("TaskDuration") === null ? null : metric("TaskDuration") * 1000,
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
          `firstTileStart=${round(result.firstTileStart)} ` +
          `initializing=${round(result.mapInitializing)} ready=${round(result.mapReady)} ` +
          `scripts=${result.scriptCount} jsDecoded=${round(result.totalJsDecoded / 1024)}KiB ` +
          `scripting=${round(result.scriptDurationMs)}ms`,
      );
    }
    const summary = {
      mode: grant ? "granted" : "denied",
      runs: runs.length,
      ttfb: round(median(runs.map((run) => run.nav?.ttfb))),
      firstTileStart: round(median(runs.map((run) => run.firstTileStart))),
      firstTileResponseEnd: round(median(runs.map((run) => run.firstTileResponseEnd))),
      mapInitializing: round(median(runs.map((run) => run.mapInitializing))),
      mapReady: round(median(runs.map((run) => run.mapReady))),
      frameAt: round(median(runs.map((run) => run.frameAt))),
      scriptCount: round(median(runs.map((run) => run.scriptCount))),
      lastScriptEnd: round(median(runs.map((run) => run.lastScriptEnd))),
      totalJsTransferKiB: round(median(runs.map((run) => run.totalJsTransfer / 1024))),
      totalJsEncodedKiB: round(median(runs.map((run) => run.totalJsEncoded / 1024))),
      totalJsDecodedKiB: round(median(runs.map((run) => run.totalJsDecoded / 1024))),
      scriptDurationMs: round(median(runs.map((run) => run.scriptDurationMs))),
      taskDurationMs: round(median(runs.map((run) => run.taskDurationMs))),
      frames: runs.map((run) => run.frame),
      rawFirstTileStart: runs.map((run) => round(run.firstTileStart)),
      rawScripting: runs.map((run) => round(run.scriptDurationMs)),
      topScripts: runs[0].topScripts.slice(0, 8),
    };
    console.log(`MEDIAN ${JSON.stringify(summary)}`);
  }
} finally {
  await browser.close();
}
