import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeReturnTo } from "../lib/auth/return-to";

test("returnTo keeps safe same-origin absolute paths, including query strings", () => {
  assert.equal(sanitizeReturnTo("/"), "/");
  assert.equal(sanitizeReturnTo("/places/abc"), "/places/abc");
  assert.equal(sanitizeReturnTo("/places/p1/experiences/e1"), "/places/p1/experiences/e1");
  assert.equal(sanitizeReturnTo("/producer/live"), "/producer/live");
  assert.equal(sanitizeReturnTo("/places/p1?tab=info#top"), "/places/p1?tab=info#top");
  // Unicode and encoded segments stay untouched.
  assert.equal(sanitizeReturnTo("/places/pasar%20induk"), "/places/pasar%20induk");
});

test("returnTo falls back to Home for empty, oversized, or malformed input", () => {
  assert.equal(sanitizeReturnTo(null), "/");
  assert.equal(sanitizeReturnTo(undefined), "/");
  assert.equal(sanitizeReturnTo(""), "/");
  assert.equal(sanitizeReturnTo("   "), "/");
  assert.equal(sanitizeReturnTo("places/p1"), "/");
  assert.equal(sanitizeReturnTo("x".repeat(513)), "/");
});

test("returnTo blocks open-redirect vectors", () => {
  // Protocol-relative host.
  assert.equal(sanitizeReturnTo("//evil.example"), "/");
  assert.equal(sanitizeReturnTo("///evil.example"), "/");
  // Absolute URLs and schemes.
  assert.equal(sanitizeReturnTo("https://evil.example"), "/");
  assert.equal(sanitizeReturnTo("HTTPS://evil.example/path"), "/");
  assert.equal(sanitizeReturnTo("javascript:alert(1)"), "/");
  assert.equal(sanitizeReturnTo("data:text/html,<script>"), "/");
  assert.equal(sanitizeReturnTo("mailto:evil@example.com"), "/");
  // Backslash and control-character tricks.
  assert.equal(sanitizeReturnTo("/\\evil.example"), "/");
  assert.equal(sanitizeReturnTo("/places/abc\\../../x"), "/");
  assert.equal(sanitizeReturnTo("/places/abc\r\nSet-Cookie: x"), "/");
  assert.equal(sanitizeReturnTo("/places/abc\n/evil"), "/");
  // Scheme smuggled before the query string.
  assert.equal(sanitizeReturnTo("/redirect?to=https://evil.example"), "/redirect?to=https://evil.example");
  // Note: only the PATH is checked for schemes — a query VALUE containing
  // "https://" is a legitimate single-hop same-origin destination, so this
  // stays (the path itself has no colon).
});
