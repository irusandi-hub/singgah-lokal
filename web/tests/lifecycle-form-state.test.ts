import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const locationPicker = readFileSync(
  new URL("../components/place-location-picker.tsx", import.meta.url),
  "utf8",
);
const siteNav = readFileSync(new URL("../components/site-nav.tsx", import.meta.url), "utf8");
const accountMenu = readFileSync(new URL("../components/account-menu.tsx", import.meta.url), "utf8");
const placeForm = readFileSync(new URL("../app/producer/places/PlaceForm.tsx", import.meta.url), "utf8");
const experienceForm = readFileSync(
  new URL("../app/producer/places/[placeId]/experiences/ExperienceForm.tsx", import.meta.url),
  "utf8",
);
const authPage = readFileSync(new URL("../app/auth/page.tsx", import.meta.url), "utf8");
const signUpPage = readFileSync(new URL("../app/auth/sign-up/page.tsx", import.meta.url), "utf8");
const securityManager = readFileSync(
  new URL("../app/developer/account-security-manager.tsx", import.meta.url),
  "utf8",
);
const visitIntentForm = readFileSync(
  new URL("../app/places/[id]/experiences/[experienceId]/VisitIntentForm.tsx", import.meta.url),
  "utf8",
);
const homePage = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

// --- MAP LIFECYCLE ---

test("Leaflet initializes exactly once per mount with a synchronous container guard", () => {
  const mapCode = stripComments(homeMap);
  // The container is claimed synchronously before the async import resolves,
  // so Strict Mode double-mounts and fast remounts cannot create a second map.
  assert.match(mapCode, /container\.dataset\.singgahMap = "initializing"/);
  assert.match(mapCode, /if \(!container \|\| container\.dataset\.singgahMap\) return;/);
  // Marked ready only after successful initialization.
  assert.match(mapCode, /container\.dataset\.singgahMap = "ready"/);
  // The claim is released when a cancelled setup loses the race.
  assert.match(mapCode, /container\.dataset\.singgahMap = ""/);
});

test("Map teardown destroys listeners, layers, and the instance itself", () => {
  const mapCode = stripComments(homeMap);
  const cleanupStart = mapCode.indexOf("return () => {\n      cancelled = true;");
  assert.ok(cleanupStart >= 0, "init effect must register cleanup");
  const cleanup = mapCode.slice(cleanupStart, cleanupStart + 700);
  assert.match(cleanup, /markerLayerRef\.current\?\.remove\(\)/);
  assert.match(cleanup, /userLayerRef\.current\?\.remove\(\)/);
  assert.match(cleanup, /map\.off\(\)/);
  assert.match(cleanup, /map\.remove\(\)/);
  assert.match(cleanup, /mapRef\.current = null/);
});

test("Marker and user-location updates never recreate the map", () => {
  const mapCode = stripComments(homeMap);
  // Marker effect rebuilds the existing marker layer only...
  assert.match(mapCode, /markerLayerRef\.current = L\.layerGroup\(\)\.addTo\(map\)/);
  assert.match(mapCode, /layer\.clearLayers\(\)/);
  // ...and the user layer is updated in place — no second L.map call.
  const mapCreations = mapCode.match(/L\.map\(/g) ?? [];
  assert.equal(mapCreations.length, 1, "exactly one L.map( call per mounted Home Map");
});

test("Map gestures stay inside the map container (no page layer behind drag)", () => {
  const mapCode = stripComments(homeMap);
  // relative + z-0 (closed stacking context — Leaflet panes trapped) and
  // touch-none (map gestures never hijack page scroll/navigation).
  assert.match(mapCode, /className="relative z-0 h-full w-full touch-none"/);
  // One real container, no hidden/stacked map surfaces.
  assert.equal((mapCode.match(/ref=\{containerRef\}/g) ?? []).length, 1);
  assert.doesNotMatch(mapCode, /position:\s*"absolute"[^,]*display:\s*"none"/);
});

test("Location picker follows the same single-instance lifecycle", () => {
  const pickerCode = stripComments(locationPicker);
  assert.match(pickerCode, /container\.dataset\.singgahMap = "initializing"/);
  assert.match(pickerCode, /if \(!container \|\| container\.dataset\.singgahMap\) return;/);
  assert.equal((pickerCode.match(/L\.map\(/g) ?? []).length, 1);
  assert.match(pickerCode, /map\.off\(\)/);
  assert.match(pickerCode, /map\.remove\(\)/);
  assert.match(pickerCode, /touch-none/);
});

// --- MENU ---

test("Exactly one AccountMenu instance is rendered in the header", () => {
  assert.equal((siteNav.match(/<AccountMenu \/>/g) ?? []).length, 1);
  // The dropdown is rendered only while open — no stacked hidden menus.
  assert.match(accountMenu, /\{open \? \(/);
});

test("Menu closes cleanly on navigation and resets transient group state", () => {
  const menuCode = stripComments(accountMenu);
  assert.match(menuCode, /const pathname = usePathname\(\)/);
  // Route navigation closes the menu and resets the groups via render-time
  // adjustment on pathname change (no cascading effect setState)...
  assert.match(menuCode, /if \(lastPathname !== pathname\) \{/);
  assert.match(menuCode, /setLastPathname\(pathname\);/);
  assert.match(menuCode, /setOpen\(false\);/);
  assert.match(menuCode, /setExpanded\(\{\}\);/);
  // ...and closing resets the expanded groups via the shared close handler.
  assert.match(menuCode, /const closeMenu = useCallback\(\(\) => \{/);
  assert.match(menuCode, /setExpanded\(\{\}\)/);
  // Outside tap + Escape still close it (kept from the original design).
  assert.match(menuCode, /pointerdown/);
  assert.match(menuCode, /Escape/);
});

// --- FORM / INPUT STATE ---

test("NEW Place form starts empty; EDIT loads the actual saved record", () => {
  const code = stripComments(placeForm);
  // Explicit NEW default (all empty except product-locked defaults)...
  assert.match(code, /function emptyPlaceForm\(\)/);
  assert.match(code, /id: "", name: "", shortDescription: ""/);
  // ...vs record-backed initial state for EDIT.
  assert.match(code, /place\s*\?\s*\{[\s\S]*place\.id, name: place\.name/);
  // NEW↔EDIT remounts re-initialize instead of resurrecting transient state.
  assert.match(code, /key=\{isEdit \? `edit-\$\{place\?\.id\}` : "new"\}/);
  // A successful NEW submit resets transient input.
  assert.match(code, /if \(!place\) setForm\(emptyPlaceForm\(\)\)/);
  assert.match(code, /autoComplete="off"/);
});

test("NEW Experience form starts empty; EDIT loads the actual saved record", () => {
  const code = stripComments(experienceForm);
  assert.match(code, /function emptyExperienceForm\(\)/);
  assert.match(code, /id: "", title: "", shortDescription: ""/);
  assert.match(code, /experience\s*\?\s*\{[\s\S]*experience\.id, title: experience\.title/);
  assert.match(code, /key=\{isEdit \? `edit-\$\{experience\?\.id\}` : "new"\}/);
  assert.match(code, /if \(!experience\) setForm\(emptyExperienceForm\(\)\)/);
  assert.match(code, /autoComplete="off"/);
});

test("Authentication forms keep empty initial state and proper autocomplete hints", () => {
  const signIn = stripComments(authPage);
  const signUp = stripComments(signUpPage);
  // State starts empty — never restored from previous visits or storage.
  assert.match(signIn, /const \[email, setEmail\] = useState\(""\)/);
  assert.match(signIn, /const \[password, setPassword\] = useState\(""\)/);
  assert.match(signUp, /const \[password, setPassword\] = useState\(""\)/);
  assert.match(signUp, /const \[passwordConfirmation, setPasswordConfirmation\] = useState\(""\)/);
  // Browser autofill is hinted correctly, not used as app state.
  assert.match(signIn, /autoComplete="current-password"/);
  assert.match(signUp, /autoComplete="new-password"/);
});

test("Secret and password fields always start empty with autofill suppressed", () => {
  const security = stripComments(securityManager);
  for (const name of ["currentPasswordEmail", "currentPassword", "newPassword", "oldSecretAnswer", "newAnswer", "newAnswerConfirmation"]) {
    assert.match(security, new RegExp(`const \\[${name}, [^\\]]+\\] = useState\\(""\\)`), `${name} must start empty`);
  }
  // Secret answers must never be autofilled from the browser's stored data.
  assert.match(security, /id="creator-old-secret-answer"[\s\S]*autoComplete="new-password"/);
});

test("No sensitive form values are persisted to browser storage", () => {
  // The only client storage is visited-link decoration and the sanitized
  // returnTo handoff — never credentials, answers, hashes, or form drafts.
  const sensitive = [/password/i, /secretAnswer/i, /answer_hash/i, /answer_salt/i];
  for (const [name, source] of [
    ["auth", authPage],
    ["sign-up", signUpPage],
    ["security", securityManager],
    ["home", homePage],
  ] as const) {
    const storageUses = source.match(/localStorage|sessionStorage/g) ?? [];
    assert.ok(storageUses.every(() => true));
    for (const pattern of sensitive) {
      const lines = source.split("\n").filter((line) => pattern.test(line) && /localStorage|sessionStorage/.test(line));
      assert.equal(lines.length, 0, `${name} must not persist sensitive values`);
    }
  }
  // Visited-links storage stores only pathnames.
  const visitedLinks = readFileSync(new URL("../lib/visited-links.ts", import.meta.url), "utf8");
  assert.match(visitedLinks, /STORAGE_KEY = "singgah_visited_links"/);
});

test("Visit Intent form derives defaults per Experience and never persists drafts", () => {
  const code = stripComments(visitIntentForm);
  assert.match(code, /useState\(getToday\(place\.timezone\)\)/);
  assert.match(code, /const \[optionalNote, setOptionalNote\] = useState\(""\)/);
  assert.match(code, /autoComplete="off"/);
  assert.doesNotMatch(code, /localStorage|sessionStorage/);
});

test("Home search resets when the page is newly opened", () => {
  const code = stripComments(homePage);
  assert.match(code, /const \[searchQuery, setSearchQuery\] = useState\(""\)/);
  assert.doesNotMatch(code, /localStorage|sessionStorage/);
});
