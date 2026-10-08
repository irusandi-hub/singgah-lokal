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
const authPage = readFileSync(new URL("../app/auth/auth-form.tsx", import.meta.url), "utf8");
const sessionRoute = readFileSync(new URL("../app/api/auth/session/route.ts", import.meta.url), "utf8");
const securityLib = readFileSync(new URL("../lib/creator/security-settings.ts", import.meta.url), "utf8");
const securityApi = readFileSync(new URL("../app/api/creator/security-settings/route.ts", import.meta.url), "utf8");
const securityManager = readFileSync(new URL("../app/developer/account-security-manager.tsx", import.meta.url), "utf8");
const secretQuestionMigration = readFileSync(
  new URL("../supabase/migrations/0014_creator_secret_question.sql", import.meta.url),
  "utf8",
);

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

test("Main header contains no Producer, Admin, or Developer menu", () => {
  assert.doesNotMatch(siteNav, /producer-nav|ProducerNav/);
  assert.doesNotMatch(siteNav, /href="\/producer|href="\/admin|href="\/developer/);
  for (const banned of ["/producer", "/admin", "/developer"]) {
    assert.ok(!siteNav.includes(`"${banned}"`), `header must not link ${banned}`);
  }
});

test("Signed-in header collapses to a single account/application menu", () => {
  assert.ok(siteNav.includes("AccountMenu"));
  const authedBlock = stripComments(siteNav).slice(
    stripComments(siteNav).indexOf("authenticated ? ("),
    stripComments(siteNav).indexOf(") : ("),
  );
  assert.doesNotMatch(authedBlock, /session\.email/);
  assert.doesNotMatch(authedBlock, /Kelola Akun/);
  assert.doesNotMatch(authedBlock, /SignOutButton/);
  const menuCode = readFileSync(new URL("../components/account-menu.tsx", import.meta.url), "utf8");
  for (const expected of ["Account Center", "Sign Out", "Setting", "Navigation", "App Language", "Video Setting", "Help", "Tentang", "/account"]) {
    assert.ok(menuCode.includes(expected), `account menu must contain ${expected}`);
  }
  assert.ok(menuCode.includes("SignOutButton"));
  assert.ok(menuCode.includes('aria-haspopup="menu"'));
  assert.ok(menuCode.includes('aria-expanded'));
  assert.ok(menuCode.includes("Escape"));
  assert.ok(menuCode.includes("pointerdown"));
  assert.ok(sessionRoute.includes('email: data?.user?.email ?? null'));
});

test("Sign Out gives explicit success feedback and only navigates after server confirms", () => {
  const signOutCode = readFileSync(new URL("../components/sign-out-button.tsx", import.meta.url), "utf8");
  assert.ok(signOutCode.includes("Berhasil keluar."));
  assert.ok(signOutCode.includes('/api/auth/sign-out'));
  const okIdx = signOutCode.indexOf('setSuccess(true)');
  const fetchIdx = signOutCode.indexOf('await fetch("/api/auth/sign-out"');
  assert.ok(fetchIdx >= 0 && okIdx > fetchIdx, "success feedback must follow the real logout");
  assert.ok(signOutCode.includes('aria-live="polite"'));
});

test("Sign In shows explicit success feedback after server confirms the session", () => {
  const signInCode = readFileSync(new URL("../app/auth/auth-form.tsx", import.meta.url), "utf8");
  assert.ok(signInCode.includes('Berhasil masuk. Mengalihkan'));
  assert.ok(signInCode.includes('role="status"'));
  const okIdx = signInCode.indexOf('setSuccess("Berhasil masuk');
  const authIdx = signInCode.indexOf("result?.authenticated !== true");
  assert.ok(authIdx >= 0 && okIdx > authIdx, "sign-in success must follow server confirmation");
});

test("Kelola Akun gateway only renders areas the account holds, server-side", () => {
  assert.ok(accountPage.includes('export const dynamic = "force-dynamic"'));
  // Pengelola authority is resolved by the memberships helper (owner/manager
  // only) and delegated Live Operator access by the live_operators helper.
  assert.ok(accountPage.includes("resolvePlaceMemberships"));
  assert.ok(accountPage.includes("resolveLiveOperatorAssignments"));
  assert.ok(accountPage.includes('platform_role === "platform_moderator"'));
  assert.ok(accountPage.includes("isCreatorEmail"));
  assert.ok(accountPage.includes('/auth?returnTo=%2Faccount'));
});

test("Developer Center is a separate guarded layer with server-side Creator auth", () => {
  assert.ok(developerLayout.includes('export const dynamic = "force-dynamic"'));
  assert.ok(developerLayout.includes("requireCreator()"));
  assert.ok(developerLayout.includes('/auth?returnTo=%2Fdeveloper'));
  assert.ok(developerLayout.includes("Akses ditolak"));
  assert.ok(developerPage.includes('export const dynamic = "force-dynamic"'));
  assert.ok(developerPage.includes("await requireCreator()"));
});

test("Platform Admin dashboard fetches its list on mount (no stuck Memuat…)", () => {
  assert.ok(developerManager.includes("useEffect("));
  assert.ok(developerManager.includes("await fetchAdmins()"));
  assert.ok(developerManager.includes("let cancelled"));
  assert.ok(developerManager.includes("const refresh = useCallback("));
});

test("Creator authorization is environment-based, fail closed, and never a DB role", () => {
  assert.ok(creatorLib.includes('import "server-only"'));
  assert.ok(creatorLib.includes("SINGGAH_CREATOR_EMAILS"));
  assert.ok(creatorLib.includes("CreatorRequiredError"));
  const code = creatorLib
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(code, /platform_moderator/);
});

test("Missing service configuration is service_not_configured, logged server-side only", () => {
  assert.ok(serviceClient.includes("ServiceConfigError"));
  assert.ok(developerLib.includes("service_not_configured"));
  assert.ok(developerLib.includes('console.error("[developer/platform-admins]'));
  assert.ok(developerApi.includes("service_not_configured: 503"));
  assert.ok(developerApi.includes("console.error"));
  assert.ok(developerManager.includes("service_not_configured"));
  assert.ok(developerManager.includes("SUPABASE_SERVICE_ROLE_KEY"));
});

test("Platform Admin grant/revoke always passes through requireCreator", () => {
  for (const name of ["listPlatformAdmins", "grantPlatformAdmin", "revokePlatformAdmin"]) {
    const fn = developerLib.slice(developerLib.indexOf(`export async function ${name}`));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.ok(body.includes("await requireCreator()"), `${name} must verify Creator authorization first`);
  }
  const grantBody = developerLib
    .slice(developerLib.indexOf("export async function grantPlatformAdmin"))
    .slice(0, developerLib.indexOf("\n}", developerLib.indexOf("export async function grantPlatformAdmin")));
  assert.ok(grantBody.includes("creator_account"));
  const revokeBody = developerLib
    .slice(developerLib.indexOf("export async function revokePlatformAdmin"))
    .slice(0, developerLib.indexOf("\n}", developerLib.indexOf("export async function revokePlatformAdmin")));
  assert.ok(revokeBody.includes("creator_account"));
});

test("Service-role client stays server-only and out of every client surface", () => {
  assert.ok(serviceClient.includes('import "server-only"'));
  const code = serviceClient
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(code.includes("process.env.SUPABASE_SERVICE_ROLE_KEY"));
  assert.doesNotMatch(code, /NEXT_PUBLIC[^\n]*SERVICE_ROLE/);
  assert.doesNotMatch(code, /console\.|return serviceRoleKey/);
});

test("Developer mutations never touch the Creator role and only set the moderator role", () => {
  const code = developerLib
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(code.includes("platform_moderator"));
  assert.doesNotMatch(code, /platform_role:\s*"creator"/i);
  assert.doesNotMatch(code, /CLOUDFLARE|VERCEL_TOKEN|DNS|SIGNING_KEY/i);
});

test("Developer API maps authorization failures without leaking internals", () => {
  assert.ok(developerApi.includes('export const dynamic = "force-dynamic"'));
  assert.ok(developerApi.includes("creator_required"));
  assert.ok(developerApi.includes("CreatorRequiredError"));
});

test("Creator account security requires password re-verification and allowlist-safe email", () => {
  assert.ok(securityApi.includes("requireCreator()"));
  assert.ok(securityApi.includes("signInWithPassword"));
  assert.ok(securityApi.includes("invalid_current_password"));
  assert.ok(securityApi.includes("isCreatorEmail(newEmail)"));
  assert.ok(securityApi.includes("updateUser({ email: newEmail })"));
  assert.ok(securityApi.includes("updateUser({ password: newPassword })"));
  assert.ok(securityApi.includes("invalid_secret_answer"));
  assert.ok(securityApi.includes("creator_required"));
  const apiCode = securityApi
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(apiCode, /SUPABASE_SERVICE_ROLE_KEY|createSupabaseServiceClient/);
});

test("Creator secret question is stored hashed, server-side only, fail-closed", () => {
  const migrationCode = secretQuestionMigration
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.ok(migrationCode.includes("enable row level security"));
  assert.doesNotMatch(migrationCode, /create policy/i);
  assert.ok(securityLib.includes('import "server-only"'));
  assert.ok(securityLib.includes("randomBytes"));
  assert.ok(securityLib.includes("scrypt"));
  assert.ok(securityLib.includes("timingSafeEqual"));
  assert.ok(securityLib.includes("answer_salt"));
  assert.ok(securityLib.includes("answer_hash"));
  const libCode = securityLib
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(libCode, /answer:\s*"[^"]+"/);
  for (const name of ["getCreatorSecretQuestion", "setCreatorSecretQuestion", "checkCreatorSecretAnswer"]) {
    const fn = securityLib.slice(securityLib.indexOf(`export async function ${name}`));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.ok(body.includes("await requireCreator()"), `${name} must verify Creator first`);
  }
});

test("Creator security settings expose no answer material and mount-fetch their status", () => {
  assert.ok(securityManager.includes("Ganti Email"));
  assert.ok(securityManager.includes("Ganti Password"));
  assert.ok(securityManager.includes("Ganti Pertanyaan Rahasia"));
  assert.ok(securityManager.includes("/api/creator/security-settings"));
  assert.ok(securityManager.includes("useEffect("));
  assert.ok(securityManager.includes("await fetchQuestionStatus()"));
  const uiCode = securityManager
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(uiCode, /answer_hash|answer_salt/);
});

test("Password field has a show/hide toggle on the login page", () => {
  assert.ok(authPage.includes("showPassword"));
  assert.ok(authPage.includes('type={showPassword ? "text" : "password"}'));
  assert.ok(authPage.includes("Sembunyikan password"));
  assert.ok(authPage.includes("Tampilkan password"));
});

test("Role sections still own their URL namespace", () => {
  assert.equal(getActiveNavSection("/producer"), "producer");
  assert.equal(getActiveNavSection("/admin/users"), "home");
  assert.equal(getActiveNavSection("/developer"), "home");
  assert.equal(getActiveNavSection("/account"), "home");
});

test("Account Center keeps no Keamanan section and separates Pengelola from delegated Live Operator access", () => {
  assert.doesNotMatch(accountPage, /<Section title="Keamanan">/);
  assert.doesNotMatch(accountPage, /Keluar dari akun ini lalu masuk kembali dengan email dan password yang sama/);
  assert.ok(accountPage.includes('<AccountProfileClient username={authority.username} />'));
  assert.ok(accountPage.includes('<AccountAccessClient memberships={authority.memberships} />'));
  // Operator Live is delegated ONLY: it is fed by active live_operators
  // assignments, never by Producer membership.
  assert.ok(accountPage.includes('<AccountLiveAccessClient assignments={authority.liveAssignments} />'));
  assert.ok(!accountPage.includes('<AccountLiveAccessClient memberships={authority.memberships} />'));
  assert.ok(accountPage.includes("resolvePlaceMemberships"));
  assert.ok(accountPage.includes("resolveLiveOperatorAssignments"));
  assert.ok(accountPage.includes('memberships: AccountPlaceMembership[]'));
  assert.ok(accountPage.includes('liveAssignments: AccountLiveOperatorAssignment[]'));
});
