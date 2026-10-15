import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * A-05 — the Live surfaces state the real capability instead of implying a
 * verification path the viewer could complete.
 *
 * The audit found copy like "Menunggu verifikasi akses Live (email terverifikasi
 * + usia ≥ 18)" on a path the server refuses unconditionally while the
 * verified-age mechanism does not exist (B1, MASTER_LIVE_POLICY §12.2 #2), which
 * reads as a pending step and contradicts the project's own UI rule that status
 * copy must never claim or imply an outcome that is not happening
 * (docs/UI_TERMINOLOGY_STANDARD.md §1, §4).
 *
 * Locked contract:
 *   1. No "Menunggu verifikasi" / "menunggu verifikasi" phrasing remains on the
 *      Live gate surfaces.
 *   2. The copy says the age verification is NOT AVAILABLE (the actual reason),
 *      and says that a verified EMAIL alone is not enough.
 *   3. Nothing implies a date of birth (or any self-declared profile field)
 *      verifies age — the standard's three verification concepts stay separate.
 *   4. No participation control is offered that is certain to fail: the comment
 *      and report surfaces render only for an ADMITTED viewer.
 *   5. The help page states the same capability truth.
 */

const viewerPage = readFileSync(new URL("../app/live/[sessionId]/page.tsx", import.meta.url), "utf8");
const viewerClient = readFileSync(
  new URL("../app/live/[sessionId]/LiveViewerClient.tsx", import.meta.url),
  "utf8",
);
const helpPage = readFileSync(new URL("../app/help/page.tsx", import.meta.url), "utf8");

/** Removes JSX/JS comments so assertions only see rendered copy. */
function stripComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

test("A-05: no Live gate copy promises a pending verification step", () => {
  for (const [name, source] of [
    ["viewer page", viewerPage],
    ["viewer client", viewerClient],
    ["help page", helpPage],
  ] as Array<[string, string]>) {
    assert.doesNotMatch(source, /Menunggu verifikasi/i, `${name}: pending-verification wording`);
    assert.doesNotMatch(source, /menunggu verifikasi/i, `${name}: pending-verification wording`);
  }
});

test("A-05: the copy states that age verification is not available yet", () => {
  // The gate state names the real reason (unavailable mechanism), not a step.
  assert.match(viewerPage, /Menonton Live belum dapat dibuka/);
  assert.match(viewerPage, /Verifikasi usia \(18\+\) belum tersedia/);
  assert.match(viewerPage, /Email terverifikasi saja tidak cukup/);
  // Same statement on the client surfaces that can produce a denial.
  assert.match(
    viewerClient,
    /Menonton Live belum dapat dibuka: verifikasi usia \(18\+\) belum tersedia\./,
  );
  assert.match(viewerClient, /Berkomentar belum dapat dibuka: verifikasi usia \(18\+\) belum tersedia\./);
  assert.match(viewerClient, /Melaporkan Live belum dapat dibuka: verifikasi usia \(18\+\) belum tersedia\./);
  // Help page carries the same truth.
  assert.match(helpPage, /verifikasi usia \(18\+\) belum tersedia/);
  assert.match(helpPage, /email terverifikasi saja tidak cukup/i);
});

test("A-05: no copy ties age eligibility to a self-declared date of birth", () => {
  for (const [name, source] of [
    ["viewer page", viewerPage],
    ["viewer client", viewerClient],
    ["help page", helpPage],
  ] as Array<[string, string]>) {
    // The user-facing language is Indonesian: no rendered copy may present a
    // date of birth as age proof (English "date of birth" may only appear in a
    // code comment explaining why it is NOT used).
    assert.doesNotMatch(source, /tanggal lahir/i, `${name}: DOB must not appear as proof`);
    const rendered = stripComments(source);
    assert.doesNotMatch(
      rendered,
      /date of birth|\bDOB\b/i,
      `${name}: DOB may only be mentioned in a code comment`,
    );
    // The age requirement stays a REQUIREMENT text, never a completable action.
    assert.doesNotMatch(source, /verifikasi usia anda|verifikasi sekarang|mulai verifikasi/i);
  }
  // The three verification concepts stay separate: no phone/management wording
  // is attached to the Live age gate.
  assert.doesNotMatch(viewerPage, /telepon|Pengelola/i);
});

test("A-05: participation surfaces render only for an admitted viewer", () => {
  // Comment + report forms live inside the `admitted ?` branch, and the
  // alternative branch states the capability instead of showing dead controls.
  const gateBranch = viewerClient.indexOf("{admitted ? (");
  const commentsSurface = viewerClient.indexOf("Comments (ephemeral)");
  const reportSurface = viewerClient.indexOf("Laporkan Live");
  const fallbackSurface = viewerClient.indexOf("Berkomentar dan melaporkan Live belum dapat dibuka");
  assert.ok(gateBranch > -1, "the participation surfaces must be gated on admission");
  assert.ok(gateBranch < commentsSurface, "the comment surface must be inside the admitted branch");
  assert.ok(commentsSurface < reportSurface && reportSurface < fallbackSurface);
  // The not-admitted branch states the capability and offers NO dead control.
  assert.doesNotMatch(viewerClient.slice(fallbackSurface), /<button|<input|<textarea|<select/);
  // The video stage still shows the honest gate state (no invented success).
  assert.match(viewerClient, /Menonton Live belum dapat dibuka: verifikasi usia \(18\+\) belum tersedia\./);
});
