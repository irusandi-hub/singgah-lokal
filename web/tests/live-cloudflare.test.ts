import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/live/cloudflare.ts", import.meta.url), "utf8");

test("Cloudflare boundary is server-only and never ships credentials to the client", () => {
  assert.match(source, /import "server-only";/);
  assert.match(source, /process\.env\.CLOUDFLARE_ACCOUNT_ID/);
  assert.match(source, /process\.env\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(source, /NEXT_PUBLIC_/);
  assert.doesNotMatch(source, /apiToken\}\s*`?\s*$/m);
});

test("Recording is hard-disabled at the provider and inputs are signed", () => {
  assert.match(source, /recording: \{ mode: "off"/);
  assert.match(source, /requireSignedURLs: true/);
});

test("Boundary fails closed on missing config or provider failure", () => {
  assert.match(source, /return null;/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /catch \{[\s\S]*?return null;/);
});
