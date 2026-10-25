/**
 * AUDIT ONLY (perf/home-js-hydration) — no dependencies beyond Playwright.
 *
 * Runs the production Home page under PageSpeed-like conditions (390x844,
 * CDP Slow-4G, 4x CPU, geolocation denied) and reports:
 *   1. every script the route loads, with decoded size and start/end;
 *   2. main-thread scripting time per script URL (CDP Tracing, devtools.timeline
 *      + v8), including the framework's own chunk;
 *   3. long tasks (>50 ms) on the main thread during the load;
 *   4. V8 precise coverage: unused JS per script;
 *   5. the same script list for a second, trivial route, so framework chunks can
 *      be separated from Home-specific ones.
 *
 * Usage: BASE_URL=http://127.0.0.1:3300 node scripts/audit-home-js.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3300";
const MOCK_FIX = { latitude: -6.9175, longitude: 107.6191 };
const TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function newPage(browser, grant = false) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    ...(grant ? { permissions: ["geolocation"], geolocation: MOCK_FIX } : {}),
  });
  const page = await context.newPage();
  const requests = new Map();
  page.on("request", (request) => {
    const url = new URL(request.url());
    const key = url.origin === new URL(BASE).origin ? url.pathname : url.origin;
    requests.set(key, (requests.get(key) ?? 0) + 1);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: Math.round((1.6 * 1024 * 1024) / 8),
    uploadThroughput: Math.round((750 * 1024) / 8),
    connectionType: "cellular4g",
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });    void requests;
    await page.route("**/tile.openstreetmap.org/**", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG }),
    );
  page.__requests = requests;
  await page.addInitScript(() => {
    window.__auditInit = null;
    const record = () => {
      const el = document.querySelector("[data-singgah-map]");
      if (el?.getAttribute("data-singgah-map") === "initializing" && window.__auditInit === null) {
        window.__auditInit = Math.round(performance.now());
      }
    };
    new MutationObserver(record).observe(document.documentElement ?? document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-singgah-map"],
    });
    document.addEventListener("DOMContentLoaded", record);
  });
  return { context, page, cdp };
}

const short = (url) => url.replace(/^https?:\/\/[^/]+/, "").replace("/_next/static/chunks/", "");

/** Collect script resources with decoded sizes and timing. */
async function scriptResources(page) {
  return page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => entry.initiatorType === "script")
      .map((entry) => ({
        url: entry.name,
        decoded: entry.decodedBodySize,
        start: Math.round(entry.startTime),
        end: Math.round(entry.responseEnd),
      })),
  );
}

async function runHome(browser) {
  const { context, page, cdp } = await newPage(browser);
  try {
    await cdp.send("Debugger.enable");
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.startPreciseCoverage", {
      callCount: false,
      detailed: true,
      allowTriggeredUpdates: false,
    });

    const traceEvents = [];
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,v8,disabled-by-default-devtools.timeline",
      transferMode: "ReportEvents",
      options: "sampling-frequency=1000",
    });
    cdp.on("Tracing.dataCollected", (payload) => traceEvents.push(...payload.value));
    const completed = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));

    await page.goto(BASE, { waitUntil: "commit" });
    await page.waitForFunction(
      () =>
        document.querySelector("[data-singgah-map]")?.getAttribute("data-singgah-map") === "ready",
      undefined,
      { timeout: 90_000, polling: 50 },
    );

    const coverage = await cdp.send("Profiler.takePreciseCoverage");
    await cdp.send("Tracing.end");
    await completed;
    const scripts = await scriptResources(page);

    // Source lengths let coverage ranges become bytes.
    const lengths = new Map();
    for (const entry of coverage.result) {
      if (!entry.url.startsWith("http")) continue;
      try {
        const source = await cdp.send("Debugger.getScriptSource", {
          scriptId: entry.scriptId,
        });
        lengths.set(entry.url, source.scriptSource.length);
      } catch {
        lengths.set(entry.url, 0);
      }
    }

    const scriptsMeta = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.initiatorType === "script")
        .map((entry) => ({
          url: entry.name,
          decoded: entry.decodedBodySize,
          start: entry.startTime,
          end: entry.responseEnd,
        })),
    );

    // Main-thread scripting per URL, and long tasks.
    const scriptingByUrl = new Map();
    const longTasks = [];
    let firstEvalEnd = null;
    const mainThreads = new Set();
    for (const event of traceEvents) {
      if (event.name === "RunTask" && event.ph === "X") {
        mainThreads.add(`${event.pid}:${event.tid}`);
      }
    }
    // The renderer main thread is the one with the most RunTask events.
    const threadCounts = new Map();
    for (const event of traceEvents) {
      if (event.name === "RunTask" && event.ph === "X") {
        const key = `${event.pid}:${event.tid}`;
        threadCounts.set(key, (threadCounts.get(key) ?? 0) + 1);
      }
    }
    // The renderer main thread is the one that evaluates page scripts, not the
    // busiest one (worker/GC threads emit most RunTask events).
    const evalThreads = new Map();
    for (const event of traceEvents) {
      if (event.name === "EvaluateScript" && event.ph === "X") {
        const key = `${event.pid}:${event.tid}`;
        evalThreads.set(key, (evalThreads.get(key) ?? 0) + 1);
      }
    }
    const mainThread =
      [...evalThreads.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      [...threadCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      null;

    for (const event of traceEvents) {
      if (!mainThread || `${event.pid}:${event.tid}` !== mainThread || event.ph !== "X") continue;
      if (event.name === "RunTask" && event.dur > 50_000) {
        longTasks.push({ start: Math.round(event.ts / 1000), ms: Math.round(event.dur / 1000) });
      }
      if (event.name === "EvaluateScript" || event.name === "CompileScript") {
        const url = event.args?.data?.url;
        if (!url || !url.startsWith("http")) continue;
        const key = short(url);
        scriptingByUrl.set(key, (scriptingByUrl.get(key) ?? 0) + event.dur / 1000);
        if (event.name === "EvaluateScript") {
          const end = event.ts + event.dur;
          if (firstEvalEnd === null || end < firstEvalEnd) firstEvalEnd = end;
        }
      }
    }

    const byUrl = new Map(scriptsMeta.map((entry) => [short(entry.url), entry]));
    const coverageByUrl = new Map();
    for (const entry of coverage.result) {
      if (!entry.url.startsWith("http")) continue;
      const key = short(entry.url);
      const sourceLength = lengths.get(entry.url) ?? 0;
      if (!sourceLength) continue;
      // Chrome's own definition of "unused": code inside functions that were
      // never called. A function's own range is the widest one in its list;
      // parent ranges tile around child functions, so this does not double count.
      let unusedChars = 0;
      for (const fn of entry.functions) {
        if (fn.ranges.length === 0) continue;
        const own = fn.ranges.reduce((widest, range) =>
          range.endOffset - range.startOffset > widest.endOffset - widest.startOffset
            ? range
            : widest,
        );
        if (own.count === 0) unusedChars += own.endOffset - own.startOffset;
      }
      unusedChars = Math.min(unusedChars, sourceLength);
      coverageByUrl.set(key, {
        unusedPct: Math.round((unusedChars / sourceLength) * 100),
        sourceKiB: Math.round(sourceLength / 1024),
      });
    }

    const rows = scriptsMeta
      .map((entry) => {
        const key = short(entry.url);
        return {
          chunk: key,
          decodedKiB: Math.round(entry.decoded / 1024),
          scriptingMs: Math.round(scriptingByUrl.get(key) ?? 0),
          unusedPct: coverageByUrl.has(key) ? coverageByUrl.get(key).unusedPct : null,
          start: Math.round(entry.start),
          end: Math.round(entry.end),
        };
      })
      .sort((a, b) => b.decodedKiB - a.decodedKiB);

    const firstEvalEndMs = firstEvalEnd === null ? null : Math.round(firstEvalEnd / 1000);
    const initAt = await page.evaluate(() => window.__auditInit ?? null);

    const traceSample = traceEvents.slice(0, 3).map((event) => `${event.name}:${event.ph}`);
    const nameCounts = new Map();
    for (const event of traceEvents) {
      if (event.ph !== "X") continue;
      nameCounts.set(event.name, (nameCounts.get(event.name) ?? 0) + 1);
    }
    const evalEvents = traceEvents.filter((event) => event.name === "EvaluateScript");
    const evalDebug = {
      count: evalEvents.length,
      threads: [...new Set(evalEvents.map((event) => `${event.pid}:${event.tid}`))].slice(0, 5),
      sample: evalEvents.slice(0, 3).map((event) => ({
        url: event.args?.data?.url,
        dur: event.dur,
        ts: event.ts,
      })),
      topNames: [...nameCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    };

    return {
      rows,
      longTasks: longTasks.sort((a, b) => b.ms - a.ms).slice(0, 12),
      longTaskTotalMs: longTasks.reduce((total, task) => total + task.ms, 0),
      firstEvalEndMs,
      initAt,
      totalDecodedKiB: rows.reduce((total, row) => total + row.decodedKiB, 0),
      totalScriptingMs: rows.reduce((total, row) => total + row.scriptingMs, 0),
      traceCount: traceEvents.length,
      traceSample,
      evalDebug,
      mainThread,
      requests: [...(page.__requests ?? new Map()).entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
    };
  } finally {
    await context.close();
  }
}

async function runOtherRoute(browser) {
  const { context, page } = await newPage(browser);
  try {
    await page.goto(new URL("/policy", BASE).toString(), { waitUntil: "load" });
    await page.waitForTimeout(1500);
    return (await scriptResources(page)).map((entry) => short(entry.url));
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch();
try {
  const home = await runHome(browser);
  console.log("=== HOME scripts (decoded KiB, scripting ms, unused %) ===");
  for (const row of home.rows) {
    console.log(
      `${String(row.decodedKiB).padStart(4)} KiB  ${String(row.scriptingMs).padStart(5)} ms  ` +
        `unused ${row.unusedPct === null ? "  n/a" : String(row.unusedPct).padStart(3) + "%"}  ` +
        `[${row.start}-${row.end}]  ${row.chunk}`,
    );
  }
  console.log(
    `TOTAL decoded=${home.totalDecodedKiB} KiB scripting=${home.totalScriptingMs} ms ` +
      `firstEvalEnd=${home.firstEvalEndMs} initAt=${home.initAt} trace=${home.traceCount} ` +
      `sample=${home.traceSample.join(",")} main=${home.mainThread}`,
  );
  console.log("=== REQUESTS (top) ===");
  for (const [path, count] of home.requests) console.log(`  ${String(count).padStart(4)}  ${path}`);
  console.log("=== LONG TASKS (>50ms) ===");
  for (const task of home.longTasks) {
    console.log(`  at ${task.start} ms  ${task.ms} ms`);
  }
  console.log(`LONG TASK total=${home.longTaskTotalMs} ms count=${home.longTasks.length}`);

  const other = await runOtherRoute(browser);
  console.log("=== /policy scripts ===");
  console.log(other.join("\n"));
  const homeOnly = home.rows.map((row) => row.chunk).filter((chunk) => !other.includes(chunk));
  console.log("=== HOME-ONLY chunks ===");
  console.log(homeOnly.join("\n"));
} finally {
  await browser.close();
}
