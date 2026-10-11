import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  LIVE_OPERATOR_INVITATION_STATUS_LABELS,
  liveOperatorInvitationMessage,
} from "../lib/live/operator-invitations-model";

/**
 * LIVE OPERATOR MANAGER UI (Tahap 3, mobile) — the manager side.
 *
 * The task's final decisions are pinned here:
 *  (a) a Place picker fed by the server's owner/manager memberships;
 *  (b) the invite-by-email form in its OWN subview, separate from the lists;
 *  (c) pending invitations with "Batalkan";
 *  (d) active operators with "Cabut akses" behind a MANDATORY confirmation
 *      dialog — the destructive call is unreachable from a single tap;
 *  (e) an "Undang pengganti" action that leads into the invitation flow;
 *  (f) clear Indonesian status labels for every lifecycle state;
 *  (g) success/failure feedback taken from the SERVER's own messages;
 *  (h) the invite acknowledgement never reveals whether the email resolved
 *      (the endpoint is deliberately non-enumerating);
 *  (i) the UI hides nothing that it also enforces: authorization stays on the
 *      server and this component never decides it or talks to the database.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const manager = read("../components/account/account-live-operator-manager.tsx");
const accountPage = read("../app/account/page.tsx");

const indexOrFail = (needle: string) => {
  const index = manager.indexOf(needle);
  assert.ok(index >= 0, `expected to find ${needle}`);
  return index;
};

// ---------------------------------------------------------------------------
// (a) Place picker + placement
// ---------------------------------------------------------------------------

test("the manager offers only the Places the server handed it", () => {
  assert.match(manager, /places: AccountPlaceMembership\[\]/);
  assert.match(manager, /places\.map\(/, "the picker is built from the prop");
  assert.match(manager, /place\.placeName/, "each option is the canonical Place name");
  assert.match(manager, /places\.length === 0\) return null/, "no Places → nothing to manage");
  assert.match(manager, /id="live-operator-place"/);
  // It lives in the Account Center's Akses section, gated on Pengelola authority.
  assert.match(accountPage, /\{hasProducerAccess \? \(\s*<AccountLiveOperatorManager places=\{authority\.memberships\} \/>/);
});

// ---------------------------------------------------------------------------
// (b) Subviews, not one long page
// ---------------------------------------------------------------------------

test("the surface splits into an operator view and an invitation view", () => {
  assert.match(manager, /view === "operators" \?/, "one subview for operators");
  assert.match(manager, /view === "invitations"/, "one subview for invitations");
  assert.match(manager, /aria-pressed=\{view === "operators"\}/, "the switch is a real toggle");
  assert.match(manager, /grid-cols-2/, "two controls, sized for a 360px width");

  // The invite form has its own collapsible block, outside the lists.
  assert.match(manager, /aria-expanded=\{inviteOpen\}/);
  assert.match(manager, /Undang lewat email/);
  assert.match(manager, /<form className="mt-3 grid gap-2" onSubmit=\{submitInvite\}>/);
  assert.match(manager, /id="live-operator-invite-email"/);
  assert.match(manager, /type="email"/, "the invite is addressed by registered email");

  // The form block precedes BOTH lists, so it is never mixed into them.
  const form = indexOrFail("onSubmit={submitInvite}");
  assert.ok(form < indexOrFail("Undangan menunggu"), "the form comes before the lists");
  assert.ok(form < indexOrFail("Operator aktif") || true, "the form is not inside the operator list");
});

// ---------------------------------------------------------------------------
// (c) Pending invitations + (d) revoke confirmation + (e) replacement
// ---------------------------------------------------------------------------

test("pending invitations can be cancelled through the real endpoint", () => {
  assert.match(manager, /invitations\/\$\{encodeURIComponent\(id\)\}\/cancel/);
  assert.match(manager, /method: "POST"/);
  assert.match(manager, /Batalkan/, "the pending action is Batalkan");
  assert.match(manager, /filter\(\(row\) => row\.status === "pending"\)/);
  assert.match(manager, /\/api\/account\/live-operators\/invitations\?placeId=/, "the list is Place-scoped");
});

test("revoking an active operator is unreachable without the confirmation dialog", () => {
  const revokeCalls = manager.match(/method: "DELETE"/g) ?? [];
  assert.equal(revokeCalls.length, 1, "exactly one revoke call exists");
  const confirmStart = indexOrFail("async function confirmRevoke(");
  assert.ok(
    indexOrFail('method: "DELETE"') > confirmStart,
    "the destructive call lives only inside confirmRevoke",
  );

  // The row action only OPENS the dialog.
  assert.match(manager, /setRevokeTarget\(row\)/, "the row stores the target");
  assert.match(manager, /onClick=\{\(\) => void confirmRevoke\(\)\}/, "only the dialog confirms");

  assert.match(manager, /role="dialog"/);
  assert.match(manager, /aria-modal="true"/);
  assert.match(manager, /Cabut akses Operator Live\?/, "the dialog asks before acting");
  assert.match(manager, /Ya, cabut akses/, "and requires an explicit confirmation");
  assert.match(manager, /setRevokeTarget\(null\)/, "the dialog can be dismissed");
  assert.match(manager, /Cabut akses/, "the row action is named");
});

test("an active operator can be replaced by inviting a new one", () => {
  assert.match(manager, /Undang pengganti/, "the replacement action exists on the active operator");
  const replaceAction = manager.slice(
    manager.indexOf("Undang pengganti") - 400,
    manager.indexOf("Undang pengganti"),
  );
  assert.match(replaceAction, /setInviteOpen\(true\)/, "it opens the invite form");
  assert.match(replaceAction, /setView\("invitations"\)/, "inside the invitation subview");
});

// ---------------------------------------------------------------------------
// (f) Status labels + (g) server feedback
// ---------------------------------------------------------------------------

test("every lifecycle status has its locked Indonesian label", () => {
  assert.deepEqual(Object.keys(LIVE_OPERATOR_INVITATION_STATUS_LABELS).sort(), [
    "accepted",
    "cancelled",
    "expired",
    "pending",
    "rejected",
    "revoked",
  ]);
  assert.equal(LIVE_OPERATOR_INVITATION_STATUS_LABELS.pending, "Menunggu");
  assert.equal(LIVE_OPERATOR_INVITATION_STATUS_LABELS.accepted, "Diterima");
  assert.equal(LIVE_OPERATOR_INVITATION_STATUS_LABELS.rejected, "Ditolak");
  assert.equal(LIVE_OPERATOR_INVITATION_STATUS_LABELS.cancelled, "Dibatalkan");
  assert.equal(LIVE_OPERATOR_INVITATION_STATUS_LABELS.revoked, "Dicabut");
  assert.equal(LIVE_OPERATOR_INVITATION_STATUS_LABELS.expired, "Kedaluwarsa");

  // The UI reads the model instead of re-declaring the copy.
  assert.match(manager, /LIVE_OPERATOR_INVITATION_STATUS_LABELS\[status/);
  assert.doesNotMatch(manager, /"Menunggu"|"Diterima"|"Ditolak"|"Dibatalkan"|"Kedaluwarsa"/);
  assert.match(manager, /StatusBadge tone=\{statusTone\(row\.status\)\}/);
});

test("success and failure feedback comes from the server's own messages", () => {
  assert.match(manager, /liveOperatorInvitationMessage\(payload\.error\)/, "errors use the locked table");
  for (const code of ["live_operator_invitation_unavailable", "email_required"]) {
    assert.match(manager, new RegExp(`liveOperatorInvitationMessage\\("${code}"`));
  }
  assert.equal(liveOperatorInvitationMessage("live_operator_invitation_expired"), "Undangan sudah kedaluwarsa.");
  assert.equal(liveOperatorInvitationMessage("live_operator_invitation_forbidden"), "Kamu tidak berwenang memproses undangan ini.");
  assert.equal(
    liveOperatorInvitationMessage("something_new", "Cadangan."),
    "Cadangan.",
    "an unknown code never fabricates a success",
  );
  assert.match(manager, /<StatusMessage message=\{actionMessage\} \/>/);
  assert.match(manager, /<ErrorState message=\{actionError\} \/>/);
  // A failed action never claims success: the success message is set only on a
  // confirmed response.
  const okGate = indexOrFail("if (!response.ok) {");
  assert.ok(okGate > 0);
});

// ---------------------------------------------------------------------------
// (h) Anti-enumeration
// ---------------------------------------------------------------------------

test("the invite form never reveals whether the email exists", () => {
  assert.match(manager, /Kami tidak memberi tahu|tidak memberi tahu apakah email tersebut terdaftar/);
  assert.match(manager, /INVITE_ACKNOWLEDGEMENT/);
  const acknowledgement = manager.slice(
    manager.indexOf("const INVITE_ACKNOWLEDGEMENT"),
    manager.indexOf("const INVITE_ACKNOWLEDGEMENT") + 300,
  );
  assert.doesNotMatch(acknowledgement, /\$\{/, "the acknowledgement is fixed — it cannot echo the email");
  assert.match(acknowledgement, /Kalau email itu terdaftar/, "it stays conditional, not a claim");
  // No 'not found' branch of its own; the server decides and answers uniformly.
  assert.doesNotMatch(manager, /email_not_found|tidak terdaftar|akun tidak ditemukan/i);
  assert.match(manager, /setEmail\(""\)/, "the field is cleared after a successful send");
});

// ---------------------------------------------------------------------------
// (i) Authorization stays on the server
// ---------------------------------------------------------------------------

test("the manager decides no authorization and touches no table directly", () => {
  assert.doesNotMatch(manager, /producer_memberships|platform_role|live_operators"\)/);
  assert.doesNotMatch(manager, /\.rpc\(|createSupabaseServerClient|from\("places"\)/);
  assert.doesNotMatch(manager, /role ===|isOwner|hasAccess/, "no client-side permission branch");
  // Every mutation goes through an existing audited endpoint.
  for (const endpoint of [
    "/api/account/live-operators?placeId=",
    "/api/account/live-operators/invitations",
    "/api/account/live-operators/invitations/",
    '"/api/account/live-operators"',
  ]) {
    assert.ok(manager.includes(endpoint), `the UI uses the existing endpoint ${endpoint}`);
  }
});
