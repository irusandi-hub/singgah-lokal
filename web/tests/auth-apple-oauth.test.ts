import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { buildOAuthCallbackUrl, describeOAuthError, normalizeOAuthProvider } from "../lib/auth/oauth";

/**
 * APPLE AUTH — second OAuth option beside Google + email/password.
 *
 * Scope: the Apple entry point on Masuk / Daftar, the Apple OAuth initiation
 * route, and provider-aware error copy. Apple must not replace Google or the
 * email/password flow, must reuse the existing Supabase Auth SSR client and
 * /auth/callback flow, and must never expose or store provider secrets.
 */

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const authForm = read("../app/auth/auth-form.tsx");
const signUpForm = read("../app/auth/sign-up/sign-up-form.tsx");
const appleButton = read("../components/apple-auth-button.tsx");
const appleRoute = read("../app/api/auth/oauth/apple/route.ts");
const callbackRoute = read("../app/auth/callback/route.ts");

// --- Error copy -----------------------------------------------------------

test("Apple OAuth failures map to Apple-specific Indonesian copy", () => {
  assert.match(describeOAuthError("access_denied", "apple") ?? "", /Masuk dengan Apple dibatalkan/);
  assert.match(describeOAuthError("missing_code", "apple") ?? "", /Masuk dengan Apple tidak selesai/);
  assert.match(describeOAuthError("oauth_exchange_failed", "apple") ?? "", /Sesi Apple/);
  assert.match(describeOAuthError("oauth_unavailable", "apple") ?? "", /masuk dengan Apple/);
  assert.match(describeOAuthError("unknown", "apple") ?? "", /Masuk dengan Apple gagal/);
  // Google stays the default and unchanged.
  assert.match(describeOAuthError("oauth_exchange_failed") ?? "", /Sesi Google/);
});

// --- Initiation route -----------------------------------------------------

test("the Apple route mirrors the Google route on the existing Supabase SSR client", () => {
  assert.match(appleRoute, /createSupabaseServerClient/);
  assert.match(appleRoute, /signInWithOAuth\(\{[\s\S]*provider: "apple"/);
  assert.match(appleRoute, /skipBrowserRedirect: true/);
  assert.match(appleRoute, /buildOAuthCallbackUrl\(origin, returnTo, "apple"\)/);
  assert.match(appleRoute, /resolveAppOrigin/);
  // Never inline provider secrets.
  assert.doesNotMatch(appleRoute, /client_secret|APPLE_CLIENT|service_role|private_key/i);
  // No role/membership/producer input on the initiation route.
  assert.doesNotMatch(appleRoute, /role|membership|producer|admin/i);
});

test("the callback stays provider-agnostic and reusable for Apple", () => {
  assert.match(callbackRoute, /exchangeCodeForSession\(code\)/);
  assert.match(callbackRoute, /sanitizeReturnTo\(searchParams\.get\("next"\)\)/);
  // It neither initiates a provider nor branches on one in code.
  assert.doesNotMatch(callbackRoute, /signInWithOAuth/);
  assert.doesNotMatch(callbackRoute, /provider:\s*"/);
  // The provider carried from the initiation route is normalized, not trusted.
  assert.match(callbackRoute, /normalizeOAuthProvider\(searchParams\.get\("provider"\)\)/);
});

test("the callback URL carries the sanitized next plus the provider", () => {
  const apple = new URL(buildOAuthCallbackUrl("https://app.example.com", "/visit-intents", "apple"));
  assert.equal(apple.searchParams.get("next"), "/visit-intents");
  assert.equal(apple.searchParams.get("provider"), "apple");
  const google = new URL(buildOAuthCallbackUrl("https://app.example.com", "/x", "google"));
  assert.equal(google.searchParams.get("provider"), "google");
});

test("normalizeOAuthProvider defaults to google for unknown values", () => {
  assert.equal(normalizeOAuthProvider("apple"), "apple");
  assert.equal(normalizeOAuthProvider("google"), "google");
  assert.equal(normalizeOAuthProvider(null), "google");
  assert.equal(normalizeOAuthProvider("evil"), "google");
});

// --- Button behavior ------------------------------------------------------

test("Apple button prevents duplicate submits and reports loading state", () => {
  assert.match(appleButton, /fetch\("\/api\/auth\/oauth\/apple"/);
  assert.match(appleButton, /if \(pending \|\| disabled\) return;/);
  assert.match(appleButton, /disabled=\{blocked\}/);
  assert.match(appleButton, /aria-busy=\{pending\}/);
  assert.match(appleButton, /Menghubungkan ke Apple/);
  // Only a real Supabase https authorize URL is followed.
  assert.match(appleButton, /result\.url\.startsWith\("https:\/\/"\)/);
  assert.doesNotMatch(appleButton, /client_secret|APPLE_CLIENT/i);
});

test("Apple button uses an Apple icon and the shared auth-button styling", () => {
  assert.match(appleButton, /AppleGlyph/);
  assert.match(appleButton, /viewBox="0 0 24 24"/);
  // Same visual language as the Google button.
  assert.match(
    appleButton,
    /className="flex w-full items-center justify-center gap-3 rounded-2xl border border-black\/12 bg-white py-3\.5 text-sm font-bold text-brand-ink transition hover:bg-black\/\[0\.03\] disabled:cursor-not-allowed disabled:opacity-60"/,
  );
});

// --- Approved hierarchy on both pages ------------------------------------

test("Masuk renders Google then Apple above the divider and email/password", () => {
  assert.match(authForm, /label="Masuk dengan Google"/);
  assert.match(authForm, /label="Masuk dengan Apple"/);
  assert.match(authForm, /import AppleAuthButton from "@\/components\/apple-auth-button"/);
  const googleAt = authForm.indexOf("Masuk dengan Google");
  const appleAt = authForm.indexOf("Masuk dengan Apple");
  const dividerAt = authForm.indexOf(">atau<");
  const formAt = authForm.indexOf("<form onSubmit={handleSubmit}");
  assert.ok(googleAt > -1 && appleAt > googleAt, "Google must appear before Apple");
  assert.ok(dividerAt > appleAt, "the divider must follow both OAuth buttons");
  assert.ok(formAt > dividerAt, "email/password form must follow the divider");
});

test("Daftar renders Google then Apple above the divider and registration fields", () => {
  assert.match(signUpForm, /label="Daftar dengan Google"/);
  assert.match(signUpForm, /label="Daftar dengan Apple"/);
  assert.match(signUpForm, /import AppleAuthButton from "@\/components\/apple-auth-button"/);
  const googleAt = signUpForm.indexOf("Daftar dengan Google");
  const appleAt = signUpForm.indexOf("Daftar dengan Apple");
  const dividerAt = signUpForm.indexOf(">atau<");
  assert.ok(googleAt > -1 && appleAt > googleAt, "Google must appear before Apple");
  assert.ok(dividerAt > appleAt, "the divider must follow both OAuth buttons");
  for (const field of ["name", "email", "password", "passwordConfirmation"]) {
    assert.match(signUpForm, new RegExp(`id="${field}"`));
  }
});
