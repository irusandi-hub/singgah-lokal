import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolveCoverLoadState } from "@/lib/place-cover";

/**
 * CARD COVER — CACHED-IMAGE REGRESSION (2026-10-20).
 *
 * BUG: Home's result cards rendered an empty cream block on a real phone. The
 * cover <img> is part of the SERVER-rendered markup, so the browser routinely
 * finishes loading it BEFORE React hydrates and attaches `onLoad`. For a
 * cached or fast image that event has already fired (and never fires again), so
 * `loaded` stayed false for good: skeleton on, photo at `opacity: 0` +
 * `blur(12px)`. Measured on production at 390×844: 55 of 62 cards still showed
 * the skeleton while `img.complete === true` and `naturalWidth` was 1200.
 *
 * These tests pin the fix: the component reconciles the ELEMENT's own state
 * (complete + naturalWidth) once per src, and the fail-closed fallback is
 * unchanged.
 */

const cover = readFileSync(new URL("../lib/place-cover.ts", import.meta.url), "utf8");
const home = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const coverComponent = home.slice(
  home.indexOf("function PlaceCardCover("),
  home.indexOf("// Home discovery (Map-first)"),
);

// ---------------------------------------------------------------------------
// The decision rule, unit-tested on its own.
// ---------------------------------------------------------------------------

test("a completed image with pixels is LOADED", () => {
  assert.equal(resolveCoverLoadState({ complete: true, naturalWidth: 1200 }), "loaded");
});

test("an image still loading is PENDING (the skeleton keeps its place)", () => {
  assert.equal(resolveCoverLoadState({ complete: false, naturalWidth: 0 }), "pending");
  assert.equal(resolveCoverLoadState(null), "pending");
  assert.equal(resolveCoverLoadState(undefined), "pending");
});

test("a completed image with NO pixels is FAILED, so the placeholder wins", () => {
  assert.equal(resolveCoverLoadState({ complete: true, naturalWidth: 0 }), "failed");
  // `complete` must be strictly true: a truthy non-boolean cannot fake a load.
  assert.equal(resolveCoverLoadState({ complete: 1 as unknown as boolean, naturalWidth: 10 }), "pending");
});

test("the helper lives in the shared, client-safe Place cover module", () => {
  assert.match(cover, /export type CoverLoadState = "pending" \| "loaded" \| "failed";/);
  assert.match(cover, /export function resolveCoverLoadState\(/);
  assert.doesNotMatch(cover, /import "server-only";/);
});

// ---------------------------------------------------------------------------
// The component uses it on the real element.
// ---------------------------------------------------------------------------

test("PlaceCardCover reconciles the mounted <img> instead of waiting for onLoad", () => {
  // A ref to the element…
  assert.match(coverComponent, /const imgRef = useRef<HTMLImageElement \| null>\(null\);/);
  assert.match(coverComponent, /ref=\{imgRef\}/);
  // …read once per src through the shared rule, so a cached image that already
  // finished loading before hydration still flips the skeleton off.
  assert.match(
    coverComponent,
    /useEffect\(\(\) => \{\s*const state = resolveCoverLoadState\(imgRef\.current\);\s*if \(state === "loaded"\) setLoaded\(true\);\s*else if \(state === "failed"\) setFailed\(true\);\s*\}, \[src\]\);/,
  );
});

test("the event path is still there, and both paths agree", () => {
  assert.match(coverComponent, /onLoad=\{\(\) => setLoaded\(true\)\}/);
  assert.match(coverComponent, /onError=\{\(\) => setFailed\(true\)\}/);
  // The skeleton is only ever the state BEFORE either path reports a load.
  assert.match(coverComponent, /\{!loaded && \(/);
  assert.match(coverComponent, /animate-pulse bg-\[#e5dfd1\]/);
});

test("a missing or unloadable cover still falls back to the local placeholder", () => {
  assert.match(
    coverComponent,
    /if \(!src \|\| failed\) \{\s*return \(\s*\/\* eslint-disable-next-line @next\/next\/no-img-element \*\/\s*<img\s*src="\/place-cover-placeholder\.svg"\s*alt=""\s*aria-hidden\s*loading="lazy"/,
  );
});

test("covers stay native images, eager only for the leading two cards", () => {
  // 62 cards x a large photo would otherwise be fetched on every load. The
  // first two cards of a row load eagerly at high priority; every later cover
  // is mounted lazily by the near-viewport gate and stays a native <img>
  // (next/image would need a host allowlist producers cannot configure).
  assert.match(coverComponent, /loading=\{priority \? "eager" : "lazy"\}/);
  assert.match(coverComponent, /fetchPriority=\{priority \? "high" : "low"\}/);
  assert.match(coverComponent, /RootMargin|rootMargin: "400px 0px"/);
  assert.doesNotMatch(coverComponent, /from "next\/image"/);
  assert.doesNotMatch(coverComponent, /<Image\b/);
});

test("the card still renders the canonical cover URL through the one component", () => {
  assert.equal(
    (home.match(/<PlaceCardCover name=\{place\.name\} src=\{place\.coverImageUrl\} priority=\{index < 2\} \/>/g) ?? [])
      .length,
    1,
  );
  // No second, unguarded <img> rendering coverImageUrl anywhere in Home.
  assert.doesNotMatch(home, /<img[^>]*place\.coverImageUrl/);
});
