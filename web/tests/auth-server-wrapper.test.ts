import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * AUTH STALE-RENDER FIX — server wrapper + force-dynamic lock.
 *
 * The production /auth route kept serving an older auth UI after deploy because
 * the route was a client-only page. Both routes are now a minimal dynamic
 * server wrapper that defers to a dedicated client form component. These tests
 * pin that structure, and confirm the wrapper refactor did not drop the Google
 * button or the email/password flow.
 */

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const authWrapper = read("../app/auth/page.tsx");
const authForm = read("../app/auth/auth-form.tsx");
const signUpWrapper = read("../app/auth/sign-up/page.tsx");
const signUpForm = read("../app/auth/sign-up/sign-up-form.tsx");

const routes = [
  { name: "/auth", wrapper: authWrapper, form: authForm, imported: "./auth-form", component: "AuthForm" },
  {
    name: "/auth/sign-up",
    wrapper: signUpWrapper,
    form: signUpForm,
    imported: "./sign-up-form",
    component: "SignUpForm",
  },
];

for (const route of routes) {
  test(`${route.name} is a SERVER wrapper with force-dynamic`, () => {
    // The route file itself must be a server component: no client directive.
    assert.doesNotMatch(route.wrapper, /"use client"|'use client'/);
    assert.match(route.wrapper, /export const dynamic = "force-dynamic"/);
    // It must defer to the dedicated client component.
    assert.match(route.wrapper, new RegExp(`import ${route.component} from "${route.imported.replace(".", "\\.")}"`));
    assert.match(route.wrapper, new RegExp(`<${route.component} />`));
    // useSearchParams consumers stay inside a Suspense boundary.
    assert.match(route.wrapper, /<Suspense/);
  });

  test(`${route.name} interactive form is a client component`, () => {
    assert.match(route.form, /^"use client";/);
  });

  test(`${route.name} still renders the Google button`, () => {
    assert.match(route.form, /import GoogleAuthButton from "@\/components\/google-auth-button"/);
    assert.match(route.form, /<GoogleAuthButton/);
  });

  test(`${route.name} still contains the email/password flow`, () => {
    assert.match(route.form, /fetch\("\/api\/auth\/(sign-in|sign-up)"/);
    assert.match(route.form, /id="email"/);
    assert.match(route.form, /id="password"/);
    assert.match(route.form, /type="submit"/);
  });
}

test("the wrapper fix uses no cache-busting params, service worker, or CDN hack", () => {
  for (const route of routes) {
    assert.doesNotMatch(route.wrapper, /serviceWorker|service-worker|_cb=|cacheBust|cache_bust/i);
  }
});
