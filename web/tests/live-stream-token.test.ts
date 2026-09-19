import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const tokenSource = readFileSync(new URL("../lib/live/stream-token.ts", import.meta.url), "utf8");
const playbackRouteSource = readFileSync(new URL("../app/api/live/playback/route.ts", import.meta.url), "utf8");
const viewerSource = readFileSync(new URL("../app/live/[sessionId]/LiveViewerClient.tsx", import.meta.url), "utf8");
const boundarySource = readFileSync(new URL("../lib/live/cloudflare.ts", import.meta.url), "utf8");

test("Token module is server-only and uses the provider signing-key mechanism", () => {
  assert.match(tokenSource, /import "server-only";/);
  // RS256 + kid header per provider docs; /token endpoint NOT used (it does
  // not support Live WebRTC).
  assert.match(tokenSource, /RS256/);
  assert.match(tokenSource, /kid: key\.keyId/);
  assert.match(tokenSource, /sub: liveInputId/);
  // No fetch to the /token endpoint (only the keys endpoint may be called).
  assert.doesNotMatch(tokenSource, /stream\/\{?[a-z_]*\}?\/token/);
  assert.match(tokenSource, /stream\/keys/);
  assert.doesNotMatch(tokenSource, /NEXT_PUBLIC_/);
});

test("Signing key custody is server-side only and fail-closed", () => {
  assert.match(tokenSource, /CLOUDFLARE_STREAM_SIGNING_KEY/);
  assert.match(tokenSource, /CLOUDFLARE_STREAM_SIGNING_KEY_ID/);
  // Any failure yields null (never an unsigned fallback).
  assert.match(tokenSource, /catch \{[\s\S]*?return null;/);
});

test("Playback route mints tokens only after every gate and never returns raw URLs", () => {
  // Gate order must precede token issuance.
  const gateIndex = playbackRouteSource.indexOf("admitLiveViewer(");
  const signIndex = playbackRouteSource.indexOf("signPlaybackToken(");
  assert.ok(gateIndex > -1 && signIndex > gateIndex, "signing must happen after admission");
  assert.doesNotMatch(playbackRouteSource, /webRTCPlayback/);
  assert.doesNotMatch(playbackRouteSource, /webRTC/);
  assert.match(playbackRouteSource, /live_playback_unavailable/);
});

test("Viewer builds the WHEP URL client-side from the token (token-in-place-of-id)", () => {
  assert.match(viewerSource, /\/webRTC\/play/);
  assert.match(viewerSource, /\$\{token\}\/webRTC\/play/);
  // No raw customer credentials; only the public customer code.
  assert.match(viewerSource, /NEXT_PUBLIC_STREAM_CUSTOMER_CODE/);
  assert.doesNotMatch(viewerSource, /CLOUDFLARE_API_TOKEN|SIGNING_KEY/);
});

test("Live inputs keep requireSignedURLs enabled (signed access never disabled)", () => {
  assert.match(boundarySource, /requireSignedURLs: true/);
  assert.match(boundarySource, /recording: \{ mode: "off"/);
});
