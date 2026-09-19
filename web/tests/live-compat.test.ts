import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const migrationSource = readFileSync(new URL("../supabase/migrations/0008_live_sessions.sql", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("../lib/live/session-service.ts", import.meta.url), "utf8");
const capSource = readFileSync(new URL("../lib/live/session-service-cap.ts", import.meta.url), "utf8");
const statusRouteSource = readFileSync(new URL("../app/api/live/status/route.ts", import.meta.url), "utf8");
const policySource = readFileSync(new URL("../../docs/masters/MASTER_LIVE_POLICY_v1.0.md", import.meta.url), "utf8");
const techSource = readFileSync(new URL("../../docs/masters/MASTER_LIVE_TECH_v1.0.md", import.meta.url), "utf8");

test("Gap 1: admit_live_viewer RPC and service call are signature-aligned and idempotent", () => {
  // Migration defines exactly one text parameter — no idempotency-key param.
  assert.match(migrationSource, /function public\.admit_live_viewer\(p_session_id text\)/);
  assert.doesNotMatch(migrationSource, /admit_live_viewer\([^)]*,/);
  // Service passes exactly one argument — no signature drift.
  assert.match(serviceSource, /rpc\("admit_live_viewer", \{\s*p_session_id: params\.sessionId,\s*\}\)/);
  assert.doesNotMatch(serviceSource, /admit_live_viewer[\s\S]{0,120}p_idempotency_key/);
  // Idempotency is preserved in-RPC: upsert on the (session, viewer) key.
  assert.match(migrationSource, /on conflict \(live_session_id, user_id\) do update\s+set admitted_at = now\(\);/);
});

test("Gap 2: replayed starts delete the freshly minted input; never overwrite the original pointer", () => {
  assert.match(serviceSource, /if \(result\.replayed\) \{\s+await deleteLiveInput\(liveInput\.liveInputId\);\s+\}/);
  // The original session's pointer is never overwritten by a replay.
  assert.doesNotMatch(serviceSource, /replayed[\s\S]{0,200}p_live_input_id/);
  // Failed RPC commits delete the minted input before aborting.
  assert.match(serviceSource, /if \(error\) \{\s+\/\/ Orphan handling[\s\S]{0,200}deleteLiveInput\(liveInput\.liveInputId\);\s+if \(String\(error\.message\)/);
  // Missing sessionId response also deletes the minted input.
  assert.match(serviceSource, /if \(!result\?\.sessionId\) \{\s+await deleteLiveInput\(liveInput\.liveInputId\);\s+throw new LiveValidationError\("live_start_failed"\);\s+\}/);
});

test("Gap 3: provider cleanup covers producer end, duration cap, stage-unpublished, and moderation", () => {
  // Service wrapper: end releases the input after the end commit; the release
  // RPC is fail-closed (verifies ended state server-side).
  assert.match(serviceSource, /release_live_input/);
  assert.match(serviceSource, /verifies the session is ended \(fail closed\)/);
  // Migration: release RPC only serves ended sessions (fail-closed) and the
  // backlog lister exists for ends outside the wrapper.
  assert.match(migrationSource, /function public\.release_live_input\(p_session_id text\)/);
  assert.match(migrationSource, /status = 'ended'\s+for update/);
  assert.match(migrationSource, /function public\.list_ended_live_inputs\(\)/);
  assert.match(migrationSource, /status = 'ended' and live_input_id is not null/);
  // Cap service broadcasts + the status route sweeps the backlog unconditionally.
  assert.match(capSource, /broadcastLiveStatus/);
  assert.match(statusRouteSource, /sweepEndedLiveInputs\(\)\.catch\(\(\) => 0\)/);
  // The sweep is NOT gated behind cap expiry (stage-unpublish/moderation ends
  // also happen outside the wrapper).
  assert.doesNotMatch(statusRouteSource, /if \(expiredIds\.length > 0\) \{[\s\S]{0,200}sweepEndedLiveInputs/);
  // Stage-unpublished trigger and moderation end both route through end_live_session.
  assert.match(migrationSource, /end_live_session\(v_live_id, 'source_stage_unpublished'/);
  assert.match(migrationSource, /perform public\.end_live_session\(p_session_id, 'moderation', p_note\);/);
});

test("Gap 4: Masters record WebRTC/WHIP + WHEP as the current decision; RTMPS/SRT/HLS/DASH annotated historical", () => {
  // Policy: §12.4 amendment exists and the §3 boundary line is annotated.
  assert.match(policySource, /Superseded for ingest\/playback by §12\.4 #1/);
  assert.match(policySource, /ingest WebRTC\/WHIP; playback WHEP/);
  assert.match(policySource, /Amended by §12\.4 #1 \(2026-09-19\)/);
  // Tech: §5 states the amendment; no un-annotated RTMPS/HLS/DASH claims remain.
  assert.match(techSource, /Ingest: WebRTC\/WHIP \(amended 2026-09-19/);
  assert.match(techSource, /does not support HLS\/DASH playback for WHIP-published inputs/);
  // No line still asserts RTMPS/SRT or HLS/DASH as the CURRENT protocol without
  // a superseded/amended annotation on the same line.
  for (const [name, source] of [["policy", policySource], ["tech", techSource]] as const) {
    for (const line of source.split("\n")) {
      if (!/RTMPS|HLS\/DASH/.test(line)) continue;
      assert.match(
        line,
        /Superseded|Amended|historical|originally|not provider-supported|replaces the original/,
        `${name} master has an un-annotated RTMPS/HLS/DASH claim: ${line.trim().slice(0, 120)}`,
      );
      assert.doesNotMatch(line, /historical annotation missing/);
    }
  }
});

test("Gap 5-6: no age-verification vendor code and no payment/monetization additions", () => {
  // No new age-verification mechanism was introduced (B1 stays fail-closed DENY).
  assert.doesNotMatch(serviceSource + capSource, /ageVerif|age-verif|idwall|jumio|veriff|sumsub/i);
  // No payment/monetization surface in the Live schema or services.
  assert.doesNotMatch(migrationSource, /payment|checkout|wallet|tipping|subscription/i);
  assert.doesNotMatch(serviceSource + capSource, /payment|checkout|wallet|tipping|subscription/i);
});
