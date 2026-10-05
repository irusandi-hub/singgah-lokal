import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  OAUTH_CALLBACK_PATH,
  OAUTH_ERROR_FALLBACK,
  buildOAuthCallbackUrl,
  describeOAuthError,
  resolveAppOrigin,
} from "../lib/auth/oauth";

/**
 * GOOGLE AUTH — UI + OAuth integration lock (2026-10-05).
 *
 * Scope: the approved Masuk / Daftar UI and Google OAuth through the EXISTING
 * Supabase Auth. These tests lock:
 *  - the two pages and their exact entry points (Google beside email/password),
 *  - the OAuth initiation + callback routes and their safe-redirect behavior,
 *  - graceful error mapping (cancel / provider / callback failures),
 *  - no parallel account system and no elevated role granted by OAuth.
 * The email/password baseline stays locked by tests/auth-return-to.test.ts and
 * tests/auth-sign-up-validation.test.ts.
 */

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

// The interactive UI now lives in the client form components; the route
// `page.tsx` files are thin dynamic server wrappers (locked by
// tests/auth-server-wrapper.test.ts).
const authPage = read("../app/auth/auth-form.tsx");
const signUpPage = read("../app/auth/sign-up/sign-up-form.tsx");
const googleButton = read("../components/google-auth-button.tsx");
const oauthRoute = read("../app/api/auth/oauth/google/route.ts");
const callbackRoute = read("../app/auth/callback/route.ts");
const signOutRoute = read("../app/api/auth/sign-out/route.ts");
const signUpRoute = read("../app/api/auth/sign-up/route.ts");
const handleNewUser = read("../supabase/migrations/0001_visit_intent_foundation.sql");

// --- Pure helpers ---------------------------------------------------------

test("OAuth callback URL carries a sanitized `next` and stays same-origin", () => {
  const safe = buildOAuthCallbackUrl("https://app.example.com", "/producer/live?tab=1");
  assert.equal(new URL(safe).pathname, OAUTH_CALLBACK_PATH);
  assert.equal(new URL(safe).origin, "https://app.example.com");
  assert.equal(new URL(safe).searchParams.get("next"), "/producer/live?tab=1");

  // Open-redirect vectors collapse to Home before they reach the URL.
  for (const evil of ["//evil.example", "https://evil.example", "javascript:alert(1)", "places/x", ""]) {
    const url = buildOAuthCallbackUrl("https://app.example.com", evil);
    assert.equal(new URL(url).searchParams.get("next"), "/");
    assert.equal(new URL(url).origin, "https://app.example.com");
  }
});

test("resolveAppOrigin prefers the configured site URL and never trusts the host header", () => {
  assert.equal(
    resolveAppOrigin("http://internal:3000/auth/callback", "https://singgah.example.com"),
    "https://singgah.example.com",
  );
  // Missing/blank/malformed configuration falls back to the request origin.
  assert.equal(resolveAppOrigin("https://preview.example.com/x", null), "https://preview.example.com");
  assert.equal(resolveAppOrigin("https://preview.example.com/x", "   "), "https://preview.example.com");
  assert.equal(resolveAppOrigin("https://preview.example.com/x", "not a url"), "https://preview.example.com");
});

test("OAuth failures map to graceful Indonesian copy", () => {
  assert.equal(describeOAuthError(null), null);
  assert.equal(describeOAuthError(""), null);
  assert.match(describeOAuthError("access_denied") ?? "", /dibatalkan/);
  assert.match(describeOAuthError("missing_code") ?? "", /Silakan coba lagi/);
  assert.match(describeOAuthError("oauth_exchange_failed") ?? "", /Sesi Google/);
  assert.equal(describeOAuthError("something_unknown"), OAUTH_ERROR_FALLBACK);
});

// --- Initiation route -----------------------------------------------------

test("the OAuth initiation route uses the existing Supabase SSR client and Google provider", () => {
  assert.match(oauthRoute, /createSupabaseServerClient/);
  assert.match(oauthRoute, /signInWithOAuth\(\{[\s\S]*provider: "google"/);
  assert.match(oauthRoute, /skipBrowserRedirect: true/);
  assert.match(oauthRoute, /buildOAuthCallbackUrl/);
  // Never inline provider secrets — they live in the Supabase project only.
  assert.doesNotMatch(oauthRoute, /client_secret|GOOGLE_CLIENT|service_role/i);
});

// --- Callback route -------------------------------------------------------

test("the callback exchanges the code with secure cookies and redirects safely", () => {
  assert.match(callbackRoute, /createSupabaseServerClient/);
  assert.match(callbackRoute, /exchangeCodeForSession\(code\)/);
  assert.match(callbackRoute, /sanitizeReturnTo\(searchParams\.get\("next"\)\)/);
  // All failure paths land back on /auth with a short error code.
  assert.match(callbackRoute, /new URL\("\/auth", origin\)/);
  assert.match(callbackRoute, /url\.searchParams\.set\("error", code\)/);
  // The success redirect is same-origin (next is a validated absolute path).
  assert.match(callbackRoute, /NextResponse\.redirect\(new URL\(next, origin\)\)/);
  // Cancel / provider error is handled before any code exchange.
  assert.match(callbackRoute, /if \(providerError\)/);
  assert.match(callbackRoute, /authErrorRedirect\(origin, "missing_code", provider\)/);
});

test("logout is provider-agnostic so Google sessions sign out like password sessions", () => {
  assert.match(signOutRoute, /supabase\.auth\.signOut\(\)/);
  assert.doesNotMatch(signOutRoute, /provider|google/i);
});

// --- Masuk (sign-in) page -------------------------------------------------

test("Masuk page renders the approved structure", () => {
  assert.match(authPage, /<h1[^>]*>\s*Masuk\s*<\/h1>/);
  assert.match(authPage, /label="Masuk dengan Google"/);
  assert.match(authPage, />atau</);
  assert.match(authPage, /Belum punya akun\?/);
  assert.match(authPage, /href="\/auth\/sign-up"/);
  assert.match(authPage, /Daftar sekarang/);
  assert.match(authPage, /<BrandLogo/);
  // Email + password remain first-class options.
  assert.match(authPage, /fetch\("\/api\/auth\/sign-in"/);
  assert.match(authPage, /type=\{showPassword \? "text" : "password"\}/);
  assert.match(authPage, /aria-label=\{showPassword \? "Sembunyikan password" : "Tampilkan password"\}/);
  // Green primary submit.
  assert.match(authPage, /bg-brand-primary py-4 text-sm font-bold text-white/);
  assert.match(authPage, /describeOAuthError\(searchParams\.get\("error"\), oauthProvider\)/);
});

// --- Daftar (sign-up) page ------------------------------------------------

test("Daftar page renders the approved structure and keeps registration fields", () => {
  assert.match(signUpPage, /<h1[^>]*>\s*Daftar\s*<\/h1>/);
  assert.match(signUpPage, /label="Daftar dengan Google"/);
  assert.match(signUpPage, />atau</);
  assert.match(signUpPage, /Sudah punya akun\?/);
  assert.match(signUpPage, /Masuk sekarang/);
  assert.match(signUpPage, /<BrandLogo/);
  for (const field of ["name", "email", "password", "passwordConfirmation"]) {
    assert.match(signUpPage, new RegExp(`id="${field}"`));
  }
  assert.match(signUpPage, /fetch\("\/api\/auth\/sign-up"/);
  assert.match(signUpPage, /bg-brand-primary py-4 text-sm font-bold text-white/);
});

// --- Google button behavior ----------------------------------------------

test("Google button prevents duplicate submits and reports loading state", () => {
  assert.match(googleButton, /fetch\("\/api\/auth\/oauth\/google"/);
  assert.match(googleButton, /if \(pending \|\| disabled\) return;/);
  assert.match(googleButton, /disabled=\{blocked\}/);
  assert.match(googleButton, /aria-busy=\{pending\}/);
  assert.match(googleButton, /Menghubungkan ke Google/);
  // Only a real Supabase https authorize URL is followed.
  assert.match(googleButton, /result\.url\.startsWith\("https:\/\/"\)/);
  assert.doesNotMatch(googleButton, /client_secret|GOOGLE_CLIENT/i);
});

test("both pages disable the other option while one auth path is in flight", () => {
  for (const page of [authPage, signUpPage]) {
    assert.match(page, /onPendingChange=\{setGooglePending\}/);
    assert.match(page, /onPendingChange=\{setApplePending\}/);
    // Google and Apple cross-disable each other while either is in flight.
    assert.match(page, /disabled=\{submitting \|\| applePending\}/);
    assert.match(page, /disabled=\{submitting \|\| googlePending\}/);
    assert.match(page, /disabled=\{submitting \|\| googlePending \|\| applePending\}/);
    assert.match(page, /if \(submitting \|\| googlePending \|\| applePending\) return;/);
  }
});

// --- Roles / no parallel account system ----------------------------------

test("Google OAuth grants no elevated role and introduces no parallel account system", () => {
  // The initiation route accepts no role/membership/producer input.
  assert.doesNotMatch(oauthRoute, /role|membership|producer|admin/i);
  // Sign-up still never accepts a role from the client (only the inline
  // comment names the forbidden fields, so assert on the code shape).
  assert.doesNotMatch(signUpRoute, /body\.(role|producer_id|producerId)|input\.(role|producer_id|producerId)/);
  // The only profile provisioning is the existing trigger: it inserts a plain
  // public.users row — no role, no membership — for every auth user, including
  // Google-authenticated ones.
  const triggerStart = handleNewUser.indexOf("create or replace function public.handle_new_user()");
  const triggerBody = handleNewUser.slice(triggerStart, handleNewUser.indexOf("$$;", triggerStart));
  assert.match(triggerBody, /insert into public\.users \(id\) values \(new\.id\)/);
  assert.doesNotMatch(triggerBody, /producer_memberships|role/);
});
