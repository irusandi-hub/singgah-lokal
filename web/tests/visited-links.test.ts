import assert from "node:assert/strict";
import test from "node:test";
import { toVisitedKey } from "../lib/visited-links";

test("top-level Place routes are tracked", () => {
  assert.equal(toVisitedKey("/places/rumah-teh-lokal"), "/places/rumah-teh-lokal");
  assert.equal(toVisitedKey("/places/rumah-teh-lokal?_refresh=1"), "/places/rumah-teh-lokal");
});

test("Experience routes are tracked", () => {
  assert.equal(
    toVisitedKey("/places/rumah-teh-lokal/experiences/adjar-teh"),
    "/places/rumah-teh-lokal/experiences/adjar-teh",
  );
});

test("Live viewer routes are tracked", () => {
  assert.equal(toVisitedKey("/live/session-123"), "/live/session-123");
});

test("non-link routes are never tracked", () => {
  assert.equal(toVisitedKey("/places"), null);
  assert.equal(toVisitedKey("/"), null);
  assert.equal(toVisitedKey("/producer/places/place-1"), null);
  assert.equal(toVisitedKey("/producer"), null);
  assert.equal(toVisitedKey("/visit-intents"), null);
  assert.equal(toVisitedKey("/auth"), null);
});
