import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * ACCOUNT CENTER — the access surface.
 *
 * Locked rules (correction, 2026-10-08):
 * - Pengelola comes from producer_memberships owner/manager only.
 * - Operator Live comes ONLY from an ACTIVE public.live_operators assignment;
 *   owner/manager membership must never produce an Operator Live card, and a
 *   delegated operator must never be shown as Pengelola.
 * - there is exactly ONE "Akses" section.
 * - each Operator Live card shows the exact canonical Place name, never a raw
 *   place id.
 * - username is self-owned: the server route updates only the caller's row.
 */

const accountPage = readFileSync(new URL("../app/account/page.tsx", import.meta.url), "utf8");
const profileClient = readFileSync(new URL("../components/account/account-profile-client.tsx", import.meta.url), "utf8");
const accessClient = readFileSync(new URL("../components/account/account-access-client.tsx", import.meta.url), "utf8");
const liveAccessClient = readFileSync(new URL("../components/account/account-live-access-client.tsx", import.meta.url), "utf8");
const liveOperatorsLib = readFileSync(new URL("../lib/account-live-operators.ts", import.meta.url), "utf8");
const membershipsLib = readFileSync(new URL("../lib/account-memberships.ts", import.meta.url), "utf8");
const usernameRoute = readFileSync(new URL("../app/api/account/username/route.ts", import.meta.url), "utf8");
const producerPlacesRoute = readFileSync(new URL("../app/api/producer/places/route.ts", import.meta.url), "utf8");
const producerSubNav = readFileSync(new URL("../components/producer-sub-nav.tsx", import.meta.url), "utf8");
const placeWorkspace = readFileSync(new URL("../app/producer/places/ProducerPlaceWorkspace.tsx", import.meta.url), "utf8");

const occurrences = (source: string, needle: string) => source.split(needle).length - 1;

test("Account Center has exactly ONE Akses section and no Keamanan section", () => {
  assert.equal(occurrences(accountPage, '<Section title="Akses">'), 1, "exactly one Akses section");
  assert.doesNotMatch(accountPage, /<Section title="Keamanan">/);
  assert.doesNotMatch(accountPage, /<Section title="Akses"[^>]*>\s*<AccountAccessClient[\s\S]*<Section title="Akses">/);
  assert.match(accountPage, /<Section title="Profil">/);
});

test("Pengelola comes from producer memberships, Operator Live from live_operators", () => {
  // Producer access: owner/manager memberships only.
  assert.match(accountPage, /<AccountAccessClient memberships=\{authority\.memberships\} \/>/);
  assert.ok(membershipsLib.includes('in("role", ["owner", "manager"])'), "Pengelola requires an owner/manager membership");
  assert.ok(accessClient.includes("memberships: AccountPlaceMembership[]"));
  assert.ok(accessClient.includes("Pengelola"));

  // Operator Live: delegated assignments only.
  assert.match(accountPage, /<AccountLiveAccessClient assignments=\{authority\.liveAssignments\} \/>/);
  assert.ok(accountPage.includes("resolveLiveOperatorAssignments"));
  assert.doesNotMatch(accountPage, /AccountLiveAccessClient memberships=/, "memberships must never feed Operator Live cards");
});

test("the Operator Live resolver reads ONLY active live_operators assignments", () => {
  assert.ok(liveOperatorsLib.includes('from("live_operators")'));
  assert.ok(liveOperatorsLib.includes('eq("user_id", userData.user.id)'), "assignments are scoped to the authenticated user");
  assert.ok(liveOperatorsLib.includes('is("revoked_at", null)'), "only non-revoked assignments are access");
  assert.doesNotMatch(liveOperatorsLib, /producer_memberships/, "Operator Live must not be derived from Producer membership");
  // Exact Place name, never a raw id as the label.
  assert.ok(liveOperatorsLib.includes('from("places")'));
  assert.ok(liveOperatorsLib.includes("placeName"));
});

test("an Operator Live card shows the exact Place name", () => {
  assert.ok(liveAccessClient.includes("assignments: AccountLiveOperatorAssignment[]"));
  assert.ok(liveAccessClient.includes("Operator Live — {placeName}"), "the card label is the canonical Place name");
  assert.doesNotMatch(liveAccessClient, /Operator Live — \{placeId\}/, "a raw place id must never be the label");
  // The id may only appear inside the link target, never as visible copy.
  assert.ok(liveAccessClient.includes("/producer/live?place="));
  assert.ok(liveAccessClient.includes("Operasi Live hanya untuk Tempat ini."));
});

test("an account with no access at all gets the honest empty state", () => {
  assert.ok(accountPage.includes("hasProducerAccess"));
  assert.ok(accountPage.includes("hasLiveOperatorAccess"));
  assert.ok(accountPage.includes("Akun ini belum memiliki akses Pengelola, Operator Live"));
  assert.ok(accountPage.includes('href="/producer/onboarding"'));
});

test("Account Center wires username self-edit through a client component", () => {
  assert.ok(accountPage.includes('<AccountProfileClient username={authority.username} />'));
  assert.ok(profileClient.includes('type Props = {'));
  assert.ok(profileClient.includes('username: string | null'));
  assert.ok(profileClient.includes('validateUsername'));
  assert.ok(profileClient.includes('/api/account/username'));
  assert.ok(profileClient.includes('role="alert"'));
  assert.ok(profileClient.includes('role="status"'));
});

test("Username route is a server POST that validates and enforces ownership only", () => {
  assert.ok(usernameRoute.includes('export async function POST'));
  assert.ok(usernameRoute.includes('validateUsername'));
  assert.ok(usernameRoute.includes('authentication_required'));
  assert.ok(usernameRoute.includes('.from("users")'));
  assert.ok(usernameRoute.includes('eq("id", userData.user.id)'), "a caller may only update its own row");
  assert.doesNotMatch(usernameRoute, /platform_moderator/);
  assert.doesNotMatch(usernameRoute, /lookup_rakyat_account_by_email/);
  assert.doesNotMatch(usernameRoute, /\.from\("live_operators"\)/);
});

test("Account Center authority probe keeps Producer, Live, Admin, and Creator separate", () => {
  assert.ok(accountPage.includes('platform_role === "platform_moderator"'));
  assert.ok(accountPage.includes("isCreatorEmail"));
  assert.ok(accountPage.includes('/auth?returnTo=%2Faccount'));
  assert.ok(accountPage.includes("memberships: AccountPlaceMembership[]"));
  assert.ok(accountPage.includes("liveAssignments: AccountLiveOperatorAssignment[]"));
});

test("Tempat is absent from Producer navigation and workspace vocabulary", () => {
  assert.doesNotMatch(producerSubNav, /Tempat/);
  assert.doesNotMatch(producerSubNav, /href="\/producer\/places"/);
  assert.match(placeWorkspace, /Tambahkan Tempat/);
});

test("/producer/places backwards-compatible route remains exposed (producer regression)", () => {
  assert.ok(producerPlacesRoute.includes('export async function GET'));
  assert.ok(producerPlacesRoute.includes('export async function POST'));
  assert.ok(producerPlacesRoute.includes('requireAuthenticatedActor'));
  assert.ok(producerPlacesRoute.includes('getServerPlaceManagementRepository'));
  assert.ok(producerPlacesRoute.includes('listForUser'));
});

test("Account Center renders no Tempat UI surface in its own scope", () => {
  assert.doesNotMatch(accountPage, /Tempat/);
  assert.doesNotMatch(accountPage, /\/producer\/places/);
});
