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

test("listAppLiveInputs parses result.liveInputs and fails closed on malformed results", async () => {
  // Real behavior test: the module is imported with the account/token config
  // set and the provider endpoint is stubbed at the fetch boundary. The
  // server-only guard is a Next.js import-time marker; the node test runner
  // IS server-side, so stubbing it in the require cache here is honest — the
  // guard itself is covered by the other tests in this file at source level.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Module = require("node:module") as { _cache: Record<string, unknown> };
  const serverOnlyKey = require.resolve("server-only");
  const hadStub = serverOnlyKey in Module._cache;
  const previousEntry = Module._cache[serverOnlyKey];
  Module._cache[serverOnlyKey] = { exports: {} };

  process.env.CLOUDFLARE_ACCOUNT_ID = "acct-selftest";
  process.env.CLOUDFLARE_API_TOKEN = "token-selftest";
  const originalFetch = globalThis.fetch;
  try {
    const { listAppLiveInputs } = await import("../lib/live/cloudflare");
    const PURPOSE = "singgah-lokal-live";
    let payload: unknown = null;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;

    // 1. The collection is read from result.liveInputs, with uid and status
    //    preserved for each app input.
    payload = {
      success: true,
      result: {
        liveInputs: [
          { uid: "input-app-1", status: "active", meta: { purpose: PURPOSE } },
          { uid: "input-app-2", status: null, meta: { purpose: PURPOSE } },
        ],
      },
    };
    const parsed = await listAppLiveInputs();
    assert.ok(Array.isArray(parsed), "result.liveInputs must be parsed as the collection");
    assert.deepEqual(
      parsed,
      [
        { uid: "input-app-1", status: "active" },
        { uid: "input-app-2", status: null },
      ],
    );

    // 2. Only this app's metadata purpose is kept; other inputs are excluded.
    payload = {
      success: true,
      result: {
        liveInputs: [
          { uid: "app-input", status: "active", meta: { purpose: PURPOSE } },
          { uid: "other-input", status: "active", meta: { purpose: "someone-else" } },
          { uid: "no-meta-input", status: "active", meta: null },
        ],
      },
    };
    const filtered = await listAppLiveInputs();
    assert.deepEqual(filtered, [{ uid: "app-input", status: "active" }]);

    // 3. A success envelope with a malformed/missing result.liveInputs is
    //    fail-closed: null means "cannot sweep", never "nothing to sweep".
    for (const brokenResult of [
      undefined,
      null,
      {},
      { liveInputs: {} },
      { liveInputs: "nope" },
    ]) {
      payload = { success: true, result: brokenResult };
      assert.equal(
        await listAppLiveInputs(),
        null,
        `malformed result must yield null: ${JSON.stringify(brokenResult)}`,
      );
    }

    // 4. A missing result key behaves the same as a malformed one.
    payload = { success: true };
    assert.equal(await listAppLiveInputs(), null);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    if (hadStub) {
      Module._cache[serverOnlyKey] = previousEntry;
    } else {
      delete Module._cache[serverOnlyKey];
    }
  }
});
