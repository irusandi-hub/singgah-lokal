import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_COMMENT_MAX_LENGTH,
  LIVE_COMMENT_MIN_INTERVAL_MS,
  LIVE_CONCURRENT_VIEWER_CAP,
  LIVE_DURATION_CAP_MINUTES,
  LIVE_GLOBAL_ACTIVE_CAP,
  LIVE_PER_PLACE_ACTIVE_CAP,
} from "../lib/live/types";

test("Locked policy limits are carried verbatim in code constants", () => {
  assert.equal(LIVE_GLOBAL_ACTIVE_CAP, 5);
  assert.equal(LIVE_PER_PLACE_ACTIVE_CAP, 1);
  assert.equal(LIVE_CONCURRENT_VIEWER_CAP, 100);
  assert.equal(LIVE_DURATION_CAP_MINUTES, 60);
});

test("Tunable comment limits match the policy tunables", () => {
  assert.equal(LIVE_COMMENT_MAX_LENGTH, 300);
  assert.equal(LIVE_COMMENT_MIN_INTERVAL_MS, 5000);
});
