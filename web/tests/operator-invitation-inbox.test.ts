import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  LIVE_OPERATOR_INVITATION_MESSAGES,
  liveOperatorInvitationMessage,
} from "../lib/live/operator-invitations-model";

/**
 * INVITEE SIDE — Operator Live invitations inside the EXISTING notification page.
 *
 * The task's decision 7 is pinned here: the invitee answers from the page they
 * are already told about (no second inbox, no duplicate navigation and no
 * decorative control), each pending invitation names its Place and the inviting
 * manager, and "Terima"/"Tolak" call the REAL endpoints. The row only changes
 * state after the server confirms, and every failure path the endpoint can
 * answer — expired, cancelled, invalid, forbidden, unavailable — is rendered
 * from the locked Indonesian message table instead of an invented success.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** Strip JS comments so a guard checks EXECUTED code, not prose. */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const invitee = read("../components/account/operator-invitation-inbox.tsx");
const inviteeCode = withoutComments(invitee);
const inboxPage = read("../app/notifications/page.tsx");
const accountMenu = read("../components/account-menu.tsx");
const siteNav = read("../components/site-nav.tsx");

test("the invitation section lives on the existing notification page", () => {
  assert.match(inboxPage, /<OperatorInvitationInbox \/>/);
  assert.match(inboxPage, /export const dynamic = "force-dynamic"/);
  assert.match(inboxPage, /requireAuthenticatedActor/, "the page stays authenticated-only");
  assert.match(inboxPage, /redirect\("\/auth\?returnTo=%2Fnotifications"\)/);
  assert.match(inboxPage, /listUserNotifications\(actor\.userId\)/, "the inbox is still the caller's own");
  assert.match(inboxPage, /title="Notifikasi"/);
});

test("no duplicate navigation or decorative control is introduced", () => {
  assert.doesNotMatch(invitee, /next\/link|<Link|href=/, "the row adds no navigation");
  assert.doesNotMatch(invitee, /<nav|aria-label="Navigasi/);
  // The header keeps exactly one inbox entry (the bell) and the menu keeps the
  // preferences entry only.
  assert.equal((siteNav.match(/href="\/notifications"/g) ?? []).length, 0);
  assert.match(siteNav, /<NotificationBell \/>/);
  assert.doesNotMatch(accountMenu, /href: "\/notifications"/);
});

test("the list is the caller's own invitations from the real endpoint", () => {
  assert.match(invitee, /fetch\("\/api\/live-operator-invitations", \{\s*\n\s*cache: "no-store",/, "the server is the source, never a cache");
  const listStart = invitee.indexOf("fetch(\"/api/live-operator-invitations\"");
  assert.match(
    invitee.slice(listStart - 200, listStart),
    /async \(\) => \{/,
    "the read happens in an effect, not from client-supplied identity",
  );
  assert.doesNotMatch(inviteeCode, /userId|auth\.uid|supabase\./i, "no client-side identity or direct data access");
});

test("a pending invitation names the Place and the inviting manager", () => {
  assert.match(invitee, /invitation\.placeName/);
  assert.match(invitee, /invitation\.invitedByName/, "the manager name comes from the server");
  assert.match(invitee, /Pengelola Tempat/, "a missing name falls back to the role, never a guess");
  assert.match(invitee, /formatWhen\(invitation\.expiresAt\)/, "the expiry is shown");
  assert.match(invitee, /title="Undangan Operator Live"/);
});

test("Terima and Tolak call the real endpoints and only the server flips the row", () => {
  assert.match(invitee, /\/api\/live-operator-invitations\/\$\{encodeURIComponent\(invitation\.id\)\}\/\$\{action\}/);
  assert.match(invitee, /method: "POST"/);
  assert.match(invitee, /act\(invitation, "accept"\)/);
  assert.match(invitee, /act\(invitation, "reject"\)/);
  assert.match(invitee, /: "Terima"\}/, "the accept button is labelled Terima");
  assert.match(invitee, /\n\s*Tolak\n/, "the reject button is labelled Tolak");

  const actBody = invitee.slice(
    invitee.indexOf("async function act("),
    invitee.indexOf('if (state === "loading")'),
  );
  const failureGate = actBody.indexOf("if (!response.ok) {");
  const flip = actBody.indexOf("setInvitations((current) =>");
  assert.ok(failureGate >= 0 && flip > failureGate, "the status flips only after response.ok");
  assert.match(actBody, /const nextStatus = action === "accept" \? "accepted" : "rejected"/);
  assert.match(actBody, /router\.refresh\(\)/, "the account surface and badge re-read the server");
  assert.match(actBody, /finally \{\s*\n\s*setBusyId\(null\);/, "the busy state is always released");
});

test("only pending invitations are actionable", () => {
  assert.match(invitee, /filter\(\(row\) => row\.status === "pending"\)/);
  assert.match(invitee, /filter\(\(row\) => row\.status !== "pending"\)/);
  assert.match(invitee, /Riwayat undangan/);
  assert.match(invitee, /LIVE_OPERATOR_INVITATION_STATUS_LABELS\[status/);
  assert.doesNotMatch(invitee, /"Menunggu"|"Diterima"|"Ditolak"|"Dibatalkan"|"Kedaluwarsa"|"Dicabut"/);
});

test("every failure path is answered with the locked Indonesian message", () => {
  assert.match(invitee, /liveOperatorInvitationMessage\(payload\.error\)/);
  assert.match(
    invitee,
    /liveOperatorInvitationMessage\("live_operator_invitation_unavailable"\)/,
    "an unavailable endpoint is reported, never hidden",
  );
  assert.equal(LIVE_OPERATOR_INVITATION_MESSAGES.live_operator_invitation_expired, "Undangan sudah kedaluwarsa.");
  assert.equal(LIVE_OPERATOR_INVITATION_MESSAGES.live_operator_invitation_invalid, "Undangan ini sudah tidak dapat diproses.");
  assert.equal(LIVE_OPERATOR_INVITATION_MESSAGES.live_operator_invitation_forbidden, "Kamu tidak berwenang memproses undangan ini.");
  assert.equal(LIVE_OPERATOR_INVITATION_MESSAGES.live_operator_invitation_not_found, "Undangan tidak ditemukan.");
  assert.equal(liveOperatorInvitationMessage(undefined), "Terjadi kesalahan. Coba lagi.");
  // The component itself never invents success copy.
  assert.doesNotMatch(invitee, /tidak dapat diproses|kedaluwarsa/i);
  assert.match(invitee, /<StatusMessage message=\{row\.message\} \/>/);
  assert.match(invitee, /<ErrorState message=\{row\.error\} \/>/);
});

test("an empty or unavailable state renders honestly", () => {
  assert.match(invitee, /if \(state === "loading"\) return null/, "no empty section flashes for every reader");
  assert.match(invitee, /if \(state === "error"\)/, "a failed read is reported, not swallowed");
  assert.match(invitee, /if \(!invitations \|\| invitations\.length === 0\) return null/);
  assert.match(invitee, /Tidak ada undangan yang menunggu jawaban\./);
});
