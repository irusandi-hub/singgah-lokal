import assert from "node:assert/strict";
import test from "node:test";
import { advanceSequence } from "../lib/live/sequence-core";

test("Server-time comment sequencing is strictly monotonic per session", () => {
  let clock = 1_000;
  const timeProvider = () => clock;

  let sequence = 0;
  sequence = advanceSequence(sequence, timeProvider());
  assert.equal(sequence, 1_000);

  // Same millisecond: never emit a duplicate/colliding sequence (I4 fix).
  sequence = advanceSequence(sequence, timeProvider());
  assert.equal(sequence, 1_001);

  // Clock moves forward: server time is used.
  clock += 50;
  sequence = advanceSequence(sequence, timeProvider());
  assert.equal(sequence, 1_050);

  // Clock jumps backwards (NTP correction): sequence still increases.
  clock = 900;
  sequence = advanceSequence(sequence, timeProvider());
  assert.equal(sequence, 1_051);
});

test("Independent sessions sequence independently", () => {
  const now = Date.now();
  assert.ok(advanceSequence(0, now) >= now);
  assert.ok(advanceSequence(advanceSequence(0, now), now) > now);
});
