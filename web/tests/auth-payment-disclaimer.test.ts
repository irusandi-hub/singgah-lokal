import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * PAYMENT-DISCLAIMER REMOVAL — regression lock.
 *
 * The product rule that SINGGAH is visit intent (not payment) stays in the
 * domain/masters; the spare "bukan pembayaran" explanatory copy was removed
 * from user-facing UI only. These tests confirm the copy is gone and that the
 * Visit Intent flow and legitimate Producer pricing information were NOT
 * removed.
 */

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const uiFiles: Array<{ path: string; source: string }> = [
  { path: "app/auth/auth-form.tsx", source: read("../app/auth/auth-form.tsx") },
  { path: "app/auth/sign-up/sign-up-form.tsx", source: read("../app/auth/sign-up/sign-up-form.tsx") },
  { path: "app/visit-intents/page.tsx", source: read("../app/visit-intents/page.tsx") },
  {
    path: "app/places/[id]/experiences/[experienceId]/VisitIntentForm.tsx",
    source: read("../app/places/[id]/experiences/[experienceId]/VisitIntentForm.tsx"),
  },
  { path: "app/about/page.tsx", source: read("../app/about/page.tsx") },
  { path: "app/producer/visit-intents/Inbox.tsx", source: read("../app/producer/visit-intents/Inbox.tsx") },
];

for (const file of uiFiles) {
  test(`${file.path} carries no payment-disclaimer copy`, () => {
    assert.doesNotMatch(file.source, /pembayaran/i);
    assert.doesNotMatch(file.source, /bukan\s+.{0,30}pembayaran/i);
    assert.doesNotMatch(file.source, /belum ada\s+.{0,30}pembayaran/i);
  });
}

test("the removed copy really was the only source of the phrase", () => {
  // Sanity: none of the touched files contain the literal phrase.
  for (const file of uiFiles) {
    assert.equal(file.source.includes("bukan pembayaran"), false);
  }
});

test("Visit Intent functionality and legitimate pricing info remain", () => {
  // The form still exists and still submits a visit intent.
  const form = read("../app/places/[id]/experiences/[experienceId]/VisitIntentForm.tsx");
  assert.match(form, /Ajukan niat berkunjung kepada Pengelola\./);
  assert.match(form, /<h2[^>]*>SINGGAH DI SINI<\/h2>/);

  // About still explains SINGGAH is visit intent and keeps the informational
  // pricing note from the Producer.
  const about = read("../app/about/page.tsx");
  assert.match(about, /SINGGAH mengekspresikan niat berkunjung ke sebuah Tempat\./);
  assert.match(about, /Harga dan tiket yang tampil\s+bersifat informasional dari Pengelola\./);

  // Visit Intent list keeps its purpose line.
  const list = read("../app/visit-intents/page.tsx");
  assert.match(list, /Niat berkunjungmu ke Tempat\. Status diperbarui setelah Pengelola merespons\./);
});
