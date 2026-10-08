import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const accountPage = readFileSync(new URL("../app/account/page.tsx", import.meta.url), "utf8");
const profileClient = readFileSync(new URL("../components/account/account-profile-client.tsx", import.meta.url), "utf8");
const accessClient = readFileSync(new URL("../components/account/account-access-client.tsx", import.meta.url), "utf8");
const liveAccessClient = readFileSync(new URL("../components/account/account-live-access-client.tsx", import.meta.url), "utf8");
const usernameRoute = readFileSync(new URL("../app/api/account/username/route.ts", import.meta.url), "utf8");
const producerPlacesRoute = readFileSync(new URL("../app/api/producer/places/route.ts", import.meta.url), "utf8");
const producerSubNav = readFileSync(new URL("../components/producer-sub-nav.tsx", import.meta.url), "utf8");
const placeWorkspace = readFileSync(new URL("../app/producer/places/ProducerPlaceWorkspace.tsx", import.meta.url), "utf8");

test("Account Center has no Keamanan section and renders only Profile and Access", () => {
  assert.doesNotMatch(accountPage, /<Section title="Keamanan">/);
  assert.doesNotMatch(accountPage, /Keluar dari akun ini lalu masuk kembali dengan email dan password yang sama/);
  assert.match(accountPage, /<Section title="Profil">/);
  assert.match(accountPage, /<Section title="Akses">/);
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
  assert.ok(usernameRoute.includes('eq("id", userData.user.id)'));
  assert.doesNotMatch(usernameRoute, /platform_moderator/);
  assert.doesNotMatch(usernameRoute, /lookup_rakyat_account_by_email/);
  assert.doesNotMatch(usernameRoute, /\.from\("live_operators"\)/);
});

test("Account Center wires producer Place access through a client component", () => {
  assert.ok(accountPage.includes('<AccountAccessClient memberships={authority.memberships} />'));
  assert.ok(accessClient.includes('type Props = {'));
  assert.ok(accessClient.includes('memberships: AccountPlaceMembership[]'));
  assert.ok(accessClient.includes('href="/producer"') || accessClient.includes('href="/producer/onboarding"'));
  assert.ok(accessClient.includes('Pengelola'));
});

test("Account Center wires Live Operator access visibility through a client component", () => {
  assert.ok(accountPage.includes('<AccountLiveAccessClient memberships={authority.memberships} />'));
  assert.ok(liveAccessClient.includes('type Props = {'));
  assert.ok(liveAccessClient.includes('memberships: AccountPlaceMembership[]'));
  assert.ok(liveAccessClient.includes('Operator Live'));
  assert.ok(liveAccessClient.includes('/producer/live?place='));
  assert.ok(liveAccessClient.includes('Operasi Live hanya untuk Tempat ini.'));
});

test("Tempat is absent from Producer navigation and workspace vocabulary", () => {
  assert.doesNotMatch(producerSubNav, /Tempat/);
  assert.doesNotMatch(producerSubNav, /href="\/producer\/places"/);
  assert.match(placeWorkspace, /Tambahkan Tempat/);
});

test("/producer/places backward-compatible compatibility route remains exposed", () => {
  assert.ok(producerPlacesRoute.includes('export async function GET'));
  assert.ok(producerPlacesRoute.includes('export async function POST'));
  assert.ok(producerPlacesRoute.includes('requireAuthenticatedActor'));
  assert.ok(producerPlacesRoute.includes('getServerPlaceManagementRepository'));
  assert.ok(producerPlacesRoute.includes('listForUser'));
});

test("Account Center authority probe still flags Producer access via owner/manager memberships", () => {
  assert.ok(accountPage.includes('in("role", ["owner", "manager"])'));
  assert.ok(accountPage.includes('platform_role === "platform_moderator"'));
  assert.ok(accountPage.includes('isCreatorEmail'));
  assert.ok(accountPage.includes('/auth?returnTo=%2Faccount'));
});

test("Account Center renders no Tempat UI surface in its own scope", () => {
  assert.doesNotMatch(accountPage, /Tempat/);
  assert.doesNotMatch(accountPage, /\/producer\/places/);
});
