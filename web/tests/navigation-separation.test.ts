import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { getActiveNavSection } from "../lib/navigation";

const siteNav = readFileSync(new URL("../components/site-nav.tsx", import.meta.url), "utf8");
const accountPage = readFileSync(new URL("../app/account/page.tsx", import.meta.url), "utf8");
const developerLayout = readFileSync(new URL("../app/developer/layout.tsx", import.meta.url), "utf8");
const developerPage = readFileSync(new URL("../app/developer/page.tsx", import.meta.url), "utf8");
const developerManager = readFileSync(new URL("../app/developer/platform-admins-manager.tsx", import.meta.url), "utf8");
const developerLib = readFileSync(new URL("../lib/developer/platform-admins.ts", import.meta.url), "utf8");
const creatorLib = readFileSync(new URL("../lib/auth/creator.ts", import.meta.url), "utf8");
const serviceClient = readFileSync(new URL("../lib/supabase/admin.ts", import.meta.url), "utf8");
const developerApi = readFileSync(new URL("../app/api/developer/platform-admins/route.ts", import.meta.url), "utf8");
const authPage = readFileSync(new URL("../app/auth/page.tsx", import.meta.url), "utf8");
const sessionRoute = readFileSync(new URL("../app/api/auth/session/route.ts", import.meta.url), "utf8");
const signOutButton = readFileSync(new URL("../components/sign-out-button.tsx", import.meta.url), "utf8");

test("Main header contains no Producer, Admin, or Developer menu", () => {
  assert.doesNotMatch(siteNav, /producer-nav|ProducerNav/);
  assert.doesNotMatch(siteNav, /href="\/producer|href="\/admin|href="\/developer/);
  for (const banned of ["/producer", "/admin", "/developer"]) {
    assert.ok(!siteNav.includes(`"${banned}"`), `header must not link ${banned}`);
  }
});

test("Header shows the account email next to Keluar, plus a single Kelola Akun entry", () => {
  assert.match(siteNav, /Kelola Akun/);
  assert.match(siteNav, /session\.email/);
  assert.match(siteNav, /SignOutButton/);
  assert.match(signOutButton, /Keluar/);
  assert.match(sessionRoute, /email: data\?\.user\?\.email \?\? null/);
});

test("Kelola Akun gateway only renders areas the account holds, server-side", () => {
  assert.match(accountPage, /export const dynamic = "force-dynamic"/);
  // Producer authority: producer_memberships ownership probe.
  assert.match(accountPage, /producer_memberships/);
  assert.match(accountPage, /in\("role", \["owner", "manager"\]\)/);
  // Platform Admin authority: canonical platform_role check.
  assert.match(accountPage, /platform_role === "platform_moderator"/);
  // Creator authority: environment allowlist (never a DB role).
  assert.match(accountPage, /isCreatorEmail/);
  // Gateway redirects signed-out visitors to auth with returnTo.
  assert.match(accountPage, /redirect\("\/auth\?returnTo=%2Faccount"\)/);
});

test("Developer Center is a separate guarded layer with server-side Creator auth", () => {
  assert.match(developerLayout, /export const dynamic = "force-dynamic"/);
  assert.match(developerLayout, /requireCreator\(\)/);
  assert.match(developerLayout, /redirect\("\/auth\?returnTo=%2Fdeveloper"\)/);
  assert.match(developerLayout, /Akses ditolak/);
  assert.match(developerPage, /export const dynamic = "force-dynamic"/);
  assert.match(developerPage, /await requireCreator\(\)/);
});

test("Platform Admin dashboard fetches its list on mount (no stuck Memuat…)", () => {
  assert.match(developerManager, /useEffect\(/);
  assert.match(developerManager, /await fetchAdmins\(\)/);
  assert.match(developerManager, /let cancelled/);
  assert.match(developerManager, /const refresh = useCallback\(/);
});

test("Creator authorization is environment-based, fail closed, and never a DB role", () => {
  assert.match(creatorLib, /import "server-only"/);
  assert.match(creatorLib, /SINGGAH_CREATOR_EMAILS/);
  assert.match(creatorLib, /CreatorRequiredError/);
  // Executable code must never model the Creator as platform_moderator
  // (comments aside, Authority Master §4).
  const code = creatorLib
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(code, /platform_moderator/);
});

test("Missing service configuration is service_not_configured, logged server-side only", () => {
  assert.match(serviceClient, /ServiceConfigError/);
  assert.match(developerLib, /service_not_configured/);
  assert.match(developerLib, /console\.error\("\[developer\/platform-admins\]/);
  assert.match(developerApi, /service_not_configured: 503/);
  assert.match(developerApi, /console\.error/);
  // The creator-only UI names the missing variable — never its value.
  assert.match(developerManager, /service_not_configured/);
  assert.match(developerManager, /SUPABASE_SERVICE_ROLE_KEY/);
});

test("Platform Admin grant/revoke always passes through requireCreator", () => {
  for (const name of ["listPlatformAdmins", "grantPlatformAdmin", "revokePlatformAdmin"]) {
    const fn = developerLib.slice(developerLib.indexOf(`export async function ${name}`));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.match(body, /await requireCreator\(\)/, `${name} must verify Creator authorization first`);
  }
  // Tier separation (Authority Master §4): the Creator can never become a moderator.
  const grantBody = developerLib
    .slice(developerLib.indexOf("export async function grantPlatformAdmin"))
    .slice(0, developerLib.indexOf("\n}", developerLib.indexOf("export async function grantPlatformAdmin")));
  assert.match(grantBody, /creator_account/);
  const revokeBody = developerLib
    .slice(developerLib.indexOf("export async function revokePlatformAdmin"))
    .slice(0, developerLib.indexOf("\n}", developerLib.indexOf("export async function revokePlatformAdmin")));
  assert.match(revokeBody, /creator_account/);
});

test("Service-role client stays server-only and out of every client surface", () => {
  assert.match(serviceClient, /import "server-only"/);
  // The service key must be a server-only env var — never NEXT_PUBLIC
  // (which gets bundled into client JS) — and never logged or returned.
  const code = serviceClient
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.match(code, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(code, /NEXT_PUBLIC[^\n]*SERVICE_ROLE/);
  assert.doesNotMatch(code, /console\.|return serviceRoleKey/);
});

test("Developer mutations never touch the Creator role and only set the moderator role", () => {
  const code = developerLib
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.match(code, /platform_moderator/);
  assert.doesNotMatch(code, /platform_role:\s*"creator"/i);
  assert.doesNotMatch(code, /CLOUDFLARE|VERCEL_TOKEN|DNS|SIGNING_KEY/i);
});

test("Developer API maps authorization failures without leaking internals", () => {
  assert.match(developerApi, /export const dynamic = "force-dynamic"/);
  assert.match(developerApi, /creator_required/);
  assert.match(developerApi, /CreatorRequiredError/);
});

test("Password field has a show/hide toggle on the login page", () => {
  assert.match(authPage, /showPassword/);
  assert.match(authPage, /type=\{showPassword \? "text" : "password"\}/);
  assert.match(authPage, /Sembunyikan password/);
  assert.match(authPage, /Tampilkan password/);
});

test("Role sections still own their URL namespace", () => {
  assert.equal(getActiveNavSection("/producer"), "producer");
  assert.equal(getActiveNavSection("/admin/users"), "home");
  assert.equal(getActiveNavSection("/developer"), "home");
  assert.equal(getActiveNavSection("/account"), "home");
});
