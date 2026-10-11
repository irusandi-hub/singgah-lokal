import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  accountProfileDisplayName,
  accountProfileInitials,
  verificationStatusLabel,
  verificationStatusTone,
} from "../lib/account/profile-view";
import {
  isPhoneVerificationAvailable,
  setPhoneOtpProvider,
} from "../lib/account/phone-otp-provider";

/**
 * PROFILE UI (Tahap 3, mobile) — the read-only summary panel and the separate
 * "Edit Profil" screen.
 *
 * Locked decisions this suite pins:
 *  - the main account page hosts NO editable profile control: the panel shows
 *    the identity summary, the verification summary, and ONE action;
 *  - "Edit Profil" is its own screen with exactly three groups (Informasi
 *    Pribadi, Kontak, Verifikasi);
 *  - the registered email is READ-ONLY on that screen and says so;
 *  - with no OTP provider/secret configured the screen states that verification
 *    is unavailable and offers NO send-code control (no certain-to-fail button),
 *    while the full send → code → result flow stays implemented for the moment
 *    the provider exists;
 *  - a phone shows as verified ONLY from server data.
 *
 * Everything is asserted against the real modules: the pure view helpers and the
 * provider capability probe are EXECUTED, not guessed from source.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const panel = read("../components/account/account-profile-client.tsx");
const editClient = read("../components/account/account-profile-edit-client.tsx");
const editPage = read("../app/account/profile/page.tsx");
const accountPage = read("../app/account/page.tsx");
const reader = read("../lib/account/profile-read.ts");

// ---------------------------------------------------------------------------
// The summary panel is read-only
// ---------------------------------------------------------------------------

test("the Profil Saya panel renders no editable profile control", () => {
  assert.doesNotMatch(panel, /<input|<textarea|<select|<form/i, "no form control on the summary panel");
  assert.doesNotMatch(panel, /useState|onChange|use client/, "the panel holds no editing state");
  assert.match(panel, /Edit Profil/, "its ONE action is Edit Profil");
  assert.match(panel, /href="\/account\/profile"/, "the action opens the Edit Profil screen");
  assert.equal((panel.match(/<button|<a /g) ?? []).length, 0, "the panel itself adds no button");
});

test("the account page keeps ONE Profil Saya panel fed by the server profile", () => {
  assert.equal((accountPage.match(/<Section title="Profil Saya">/g) ?? []).length, 1);
  assert.match(
    accountPage,
    /<AccountProfileClient[\s\S]*?fullName=\{profile\.fullName\}[\s\S]*?username=\{profile\.username\}[\s\S]*?email=\{authority\.email\}[\s\S]*?avatarUrl=\{profile\.avatarUrl\}[\s\S]*?verification=\{profile\.verification\}/,
    "every panel value comes from the server read",
  );
});

test("the avatar is a real photo or the account's own initials — never invented", () => {
  assert.equal(accountProfileInitials({ fullName: "Budi Santoso" }), "BS");
  assert.equal(accountProfileInitials({ username: "budi-santoso" }), "BS");
  assert.equal(accountProfileInitials({ email: "budi@example.com" }), "BU");
  assert.equal(accountProfileInitials({}), "?");
  assert.equal(accountProfileDisplayName({ fullName: "  Budi  " }), "Budi");
  assert.equal(accountProfileDisplayName({ username: "budi" }), "budi");
  assert.equal(accountProfileDisplayName({ email: "budi@example.com" }), "budi@example.com");
  assert.equal(accountProfileDisplayName({}), "Akun SINGGAH LOKAL");
  // The photo path is the server's signed URL; the initials are the fallback.
  assert.match(panel, /avatarUrl \?/, "a stored photo wins");
  assert.match(panel, /accountProfileInitials/, "otherwise the initials are shown");
  assert.doesNotMatch(panel, /getPublicUrl|storage\/v1\/object\/public/, "no public bucket URL");
});

// ---------------------------------------------------------------------------
// The Edit Profil screen
// ---------------------------------------------------------------------------

test("Edit Profil is a separate, authenticated screen with three groups in order", () => {
  assert.match(editPage, /export const dynamic = "force-dynamic"/);
  assert.match(editPage, /readOwnProfile\(\)/, "the screen reads the caller's own profile server-side");
  assert.match(editPage, /redirect\("\/auth\?returnTo=%2Faccount%2Fprofile"\)/, "signed-out → existing auth flow");
  assert.match(editPage, /title="Edit Profil"/);

  const personal = editClient.indexOf("Informasi Pribadi");
  const contact = editClient.indexOf('title="Kontak"');
  const verification = editClient.indexOf('title="Verifikasi"');
  assert.ok(personal >= 0 && contact > personal && verification > contact, "three groups, in the decided order");
  assert.equal(
    (editClient.match(/<Group/g) ?? []).length,
    3,
    "exactly three groups — nothing else was added",
  );
  for (const field of ["Nama lengkap", "Username", "Tanggal lahir"]) {
    assert.ok(editClient.includes(field), `Informasi Pribadi keeps ${field}`);
  }
});

test("the registered email is read-only and explains where it can be changed", () => {
  assert.match(editClient, /id="profile-email"/);
  assert.match(editClient, /readOnly/, "the email field is read-only");
  assert.match(editClient, /disabled/, "and cannot be submitted by accident");
  assert.match(editClient, /alur keamanan akun/, "the screen names the real change flow");
  // The email is never part of the write payload.
  assert.doesNotMatch(editClient, /update\.(email|email_confirmed_at|phone_verified_at|platform_role)/);
  for (const owned of ["update.full_name", "update.username", "update.date_of_birth", "update.phone"]) {
    assert.ok(editClient.includes(owned), `${owned} is a self-owned write`);
  }
});

test("the phone flow is unavailable when the server cannot deliver an OTP", () => {
  const previousSecret = process.env.PHONE_OTP_HASH_SECRET;
  delete process.env.PHONE_OTP_HASH_SECRET;
  setPhoneOtpProvider(null);
  assert.equal(isPhoneVerificationAvailable(), false, "no provider and no secret");

  setPhoneOtpProvider({ async sendOtp() {} });
  assert.equal(
    isPhoneVerificationAvailable(),
    false,
    "a provider without the hash secret still fails closed",
  );

  process.env.PHONE_OTP_HASH_SECRET = "test-secret";
  assert.equal(isPhoneVerificationAvailable(), true, "both halves present → the flow is usable");

  if (previousSecret === undefined) delete process.env.PHONE_OTP_HASH_SECRET;
  else process.env.PHONE_OTP_HASH_SECRET = previousSecret;
  setPhoneOtpProvider(null);
  assert.equal(isPhoneVerificationAvailable(), false, "the seam can be reset to fail closed");
});

test("no send-code button is offered while verification is unavailable", () => {
  const unavailable = editClient.indexOf("phone_otp_provider_not_configured");
  const sendControl = editClient.indexOf("Kirim kode verifikasi");
  assert.ok(unavailable >= 0, "the unavailable status is rendered");
  assert.ok(sendControl > unavailable, "the send control lives in the OTHER (available) branch");
  assert.match(
    editClient,
    /!phoneVerificationAvailable \? \(/,
    "the branch is driven by the server capability probe",
  );
  assert.doesNotMatch(editClient, /disabled[^>]*Kirim kode verifikasi/, "no disabled certain-to-fail button");
});

test("the full OTP flow stays implemented so it activates with the provider", () => {
  assert.match(editClient, /fetch\("\/api\/account\/phone\/otp", \{/, "request a code");
  assert.match(editClient, /fetch\("\/api\/account\/phone\/otp\/verify", \{/, "confirm the code");
  assert.match(editClient, /challengeId/, "the challenge comes from the server response");
  assert.match(editClient, /phoneOtpMessage/, "results use the locked Indonesian message table");
  // Wrong / expired / too-many-attempts / success are all rendered from the
  // server's own status and message.
  assert.match(editClient, /payload\.status === "phone_otp_verified"/);
  assert.match(editClient, /setOtpError\(payload\.message \?\? phoneOtpMessage\(payload\.status\)\)/);
});

test("a phone is reported verified only from server data", () => {
  assert.doesNotMatch(editClient, /setPhoneVerified|setEmailVerified|verified: true/);
  assert.match(editClient, /verification\.phone\.verified/, "the badge reads the server payload");
  assert.match(editClient, /router\.refresh\(\)/, "a success re-reads the server profile");
  assert.match(
    editClient,
    /Status di bawah ini berasal dari data server/,
    "the group states where the status comes from",
  );
  // Verification stays SEPARATE: no manager/Place status is ever combined in.
  for (const source of [editClient, panel]) {
    assert.doesNotMatch(source, /claim_status|managerVerified|placeVerified|producerVerified/);
  }
});

test("verification wording distinguishes absent data from unverified data", () => {
  assert.equal(verificationStatusLabel(null, false), "Belum ada");
  assert.equal(verificationStatusLabel("   ", false), "Belum ada");
  assert.equal(verificationStatusLabel("+6281234567890", false), "Belum terverifikasi");
  assert.equal(verificationStatusLabel("+6281234567890", true), "Terverifikasi");
  assert.equal(verificationStatusLabel("budi@example.com", true), "Terverifikasi");
  assert.equal(verificationStatusTone("+6281234567890", true), "positive");
  assert.equal(verificationStatusTone(null, true), "neutral", "a verified flag with no value is not a fact");
  assert.equal(verificationStatusTone("budi@example.com", false), "neutral");
});

// ---------------------------------------------------------------------------
// Server-side read
// ---------------------------------------------------------------------------

test("the profile read is self-scoped, server-computed, and never public", () => {
  assert.match(reader, /import "server-only"/);
  assert.match(reader, /eq\("id", user\.id\)/, "the subject is always the authenticated session");
  assert.doesNotMatch(reader, /userId|user_id/, "no client-supplied subject exists");
  assert.match(reader, /calculateAge\(row\.date_of_birth\)/, "the age is computed on the server");
  assert.match(reader, /buildVerificationSummary\(/, "the summary is built from the stored facts");
  assert.match(reader, /createAvatarSignedUrl\(/, "the photo is a signed URL");
  assert.doesNotMatch(reader, /getPublicUrl|\.list\(/);
  assert.match(reader, /isPhoneVerificationAvailable\(\)/, "the capability probe is server-side");
});
