import assert from "node:assert/strict";
import test from "node:test";
import { getActiveNavSection, isActiveNavSection, normalizeNavPathname } from "../lib/navigation";

test("Home is active on the root and on non-section routes", () => {
  assert.equal(getActiveNavSection("/"), "home");
  assert.equal(getActiveNavSection("/places/rumah-teh-lokal"), "home");
  assert.equal(getActiveNavSection("/places/rumah-teh-lokal/experiences/exp-1"), "home");
  assert.equal(getActiveNavSection("/auth"), "home");
});

test("Live is active on viewer routes only", () => {
  assert.equal(getActiveNavSection("/live/session-1"), "live");
  assert.equal(getActiveNavSection("/live/"), "live");
  assert.equal(getActiveNavSection("/live"), "live");
});

test("Producer is active on every Producer route, including nested detail pages", () => {
  assert.equal(getActiveNavSection("/producer"), "producer");
  assert.equal(getActiveNavSection("/producer/visit-intents"), "producer");
  assert.equal(getActiveNavSection("/producer/visit-intents/intent-9"), "producer");
  assert.equal(getActiveNavSection("/producer/places/place-1/experiences/exp-2"), "producer");
  assert.equal(getActiveNavSection("/producer/live"), "producer");
});

test("Visit Intent Saya is active on the user list route", () => {
  assert.equal(getActiveNavSection("/visit-intents"), "visit-intents");
  assert.equal(getActiveNavSection("/visit-intents/?_refresh=1"), "visit-intents");
});

test("Sections do not swallow each other's routes", () => {
  assert.notEqual(getActiveNavSection("/producer/live"), "live");
  assert.notEqual(getActiveNavSection("/live/session-1"), "producer");
});

test("Query strings and hashes never change the active section", () => {
  assert.equal(getActiveNavSection("/?_refresh=123"), "home");
  assert.equal(getActiveNavSection("/producer/visit-intents?status=pending#list"), "producer");
});

test("isActiveNavSection matches by URL so refresh/direct URL keeps state", () => {
  assert.equal(isActiveNavSection("/producer/places", "producer"), true);
  assert.equal(isActiveNavSection("/producer/places", "home"), false);
  assert.equal(isActiveNavSection("/", "home"), true);
});

test("Pathnames normalize before matching", () => {
  assert.equal(normalizeNavPathname("/visit-intents?x=1#top"), "/visit-intents");
  assert.equal(normalizeNavPathname(""), "/");
});
