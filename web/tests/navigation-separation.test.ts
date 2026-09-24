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

test("Signed-in header collapses to a single ☰ account/application menu", () => {
  // Email, standalone Kelola Akun, and standalone Sign Out are gone from the
  // header surface; one ☰ menu (AccountMenu) becomes the entry point.
  assert.match(siteNav, /AccountMenu/);
  const authedBlock = stripComments(siteNav).slice(
    stripComments(siteNav).indexOf("authenticated ? ("),
    stripComments(siteNav).indexOf(") : ("),
  );
  assert.doesNotMatch(authedBlock, /session\.email/);
  assert.doesNotMatch(authedBlock, /Kelola Akun/);
  assert.doesNotMatch(authedBlock, /SignOutButton/);
  // The menu itself owns the entries and the real sign-out mechanism.
  const menuCode = readFileSync(new URL("../components/account-menu.tsx", import.meta.url), "utf8");
  for (const expected of ["Account Center", "Sign Out", "Setting", "Navigation", "App Language", "Video Setting", "Help", "About & Terms", "/account"]) {
    assert.ok(menuCode.includes(expected), `account menu must contain ${expected}`);
  }
  assert.match(menuCode, /SignOutButton/);
  assert.match(menuCode, /aria-haspopup="menu"/);
  assert.match(menuCode, /aria-expanded/);
  assert.match(menuCode, /Escape/);
  assert.match(menuCode, /pointerdown/);
  // Session probe keeps returning the email (used elsewhere), header does not render it.
  assert.match(sessionRoute, /email: data\?\.user\?\.email \?\? null/);
});

test("Sign Out gives explicit success feedback and only navigates after server confirms", () => {
  const signOutCode = readFileSync(new URL("../components/sign-out-button.tsx", import.meta.url), "utf8");
  assert.match(signOutCode, /Berhasil keluar\./);
  assert.match(signOutCode, /api\/auth\/sign-out/);
  // Success state is set only after the fetch response (not on click).
  const okIdx = signOutCode.indexOf("setSuccess(true)");
  const fetchIdx = signOutCode.indexOf('await fetch("/api/auth/sign-out"');
  assert.ok(fetchIdx >= 0 && okIdx > fetchIdx, "success feedback must follow the real logout");
  assert.match(signOutCode, /aria-live="polite"/);
});

test("Sign In shows explicit success feedback after server confirms the session", () => {
  const signInCode = readFileSync(new URL("../app/auth/page.tsx", import.meta.url), "utf8");
  assert.match(signInCode, /Berhasil masuk\. Mengalihkan/);
  assert.match(signInCode, /role="status"/);
  // Success only after the authenticated check passed.
  const okIdx = signInCode.indexOf('setSuccess("Berhasil masuk');
  const authIdx = signInCode.indexOf("result?.authenticated !== true");
  assert.ok(authIdx >= 0 && okIdx > authIdx, "sign-in success must follow server confirmation");
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

test("Creator account security requires password re-verification and allowlist-safe email", () => {
  assert.match(securityApi, /requireCreator\(\)/);
  assert.match(securityApi, /signInWithPassword/);
  assert.match(securityApi, /invalid_current_password/);
  assert.match(securityApi, /isCreatorEmail\(newEmail\)/);
  assert.match(securityApi, /updateUser\(\{ email: newEmail \}\)/);
  assert.match(securityApi, /updateUser\(\{ password: newPassword \}\)/);
  assert.match(securityApi, /invalid_secret_answer/);
  assert.match(securityApi, /creator_required/);
  // Supabase Auth is the system of record for email/password — no service
  // role in these flows.
  const apiCode = securityApi
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(apiCode, /SUPABASE_SERVICE_ROLE_KEY|createSupabaseServiceClient/);
});

test("Creator secret question is stored hashed, server-side only, fail-closed", () => {
  // RLS enabled with no policies => anon/authenticated can never touch rows.
  // (Comments are stripped so the doc line "no CREATE POLICY" doesn't count.)
  const migrationCode = secretQuestionMigration
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.match(migrationCode, /enable row level security/);
  assert.doesNotMatch(migrationCode, /create policy/i);
  // Answer is a salted scrypt hash — never plaintext, never hardcoded.
  assert.match(securityLib, /import "server-only"/);
  assert.match(securityLib, /randomBytes/);
  assert.match(securityLib, /scrypt/);
  assert.match(securityLib, /timingSafeEqual/);
  assert.match(securityLib, /answer_salt/);
  assert.match(securityLib, /answer_hash/);
  const libCode = securityLib
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  // No hardcoded/default answer ever exists in source.
  assert.doesNotMatch(libCode, /answer:\s*"[^"]+"/);
  // Every storage operation re-verifies Creator authorization.
  for (const name of ["getCreatorSecretQuestion", "setCreatorSecretQuestion", "checkCreatorSecretAnswer"]) {
    const fn = securityLib.slice(securityLib.indexOf(`export async function ${name}`));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.match(body, /await requireCreator\(\)/, `${name} must verify Creator first`);
  }
});

test("Creator security settings expose no answer material and mount-fetch their status", () => {
  assert.match(securityManager, /Ganti Email/);
  assert.match(securityManager, /Ganti Password/);
  assert.match(securityManager, /Ganti Pertanyaan Rahasia/);
  assert.match(securityManager, /api\/creator\/security-settings/);
  assert.match(securityManager, /useEffect\(/);
  assert.match(securityManager, /await fetchQuestionStatus\(\)/);
  // The UI must never receive hash/salt material.
  const uiCode = securityManager
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(uiCode, /answer_hash|answer_salt/);
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
