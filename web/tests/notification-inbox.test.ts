import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationBellLink } from "../components/notification-bell";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORY_CATALOG,
  formatUnreadBadge,

  resolveNotificationHref,
} from "../lib/notifications-model";

/**
 * Notification surface contract (header bell, inbox, settings).
 *
 * The bell's presentational link is rendered for real (react-dom/server), so
 * the badge rules and the accessible name are verified on actual markup — not
 * on a source guess. Everything else follows the repo convention of scanning
 * the component/route sources for the authorization and scope contracts.
 */

const siteNav = readFileSync(new URL("../components/site-nav.tsx", import.meta.url), "utf8");
const accountMenu = readFileSync(new URL("../components/account-menu.tsx", import.meta.url), "utf8");
const bell = readFileSync(new URL("../components/notification-bell.tsx", import.meta.url), "utf8");
const inboxPage = readFileSync(new URL("../app/notifications/page.tsx", import.meta.url), "utf8");
const settingsPage = readFileSync(new URL("../app/account/notifications/page.tsx", import.meta.url), "utf8");
const settingsForm = readFileSync(new URL("../components/notification-settings-form.tsx", import.meta.url), "utf8");
const inboxItem = readFileSync(new URL("../components/notification-inbox-item.tsx", import.meta.url), "utf8");

const render = (unreadCount: number) =>
  renderToStaticMarkup(createElement(NotificationBellLink, { unreadCount }));

// --- Badge rules (MASTER 10 §9) --------------------------------------------

test("unread badge: 0 → none, 1–99 → the number, 100+ → 99+", () => {
  assert.equal(formatUnreadBadge(0), null);
  assert.equal(formatUnreadBadge(1), "1");
  assert.equal(formatUnreadBadge(7), "7");
  assert.equal(formatUnreadBadge(99), "99");
  assert.equal(formatUnreadBadge(100), "99+");
  assert.equal(formatUnreadBadge(250), "99+");
  // Defensive: nothing may render a badge for nonsense input.
  assert.equal(formatUnreadBadge(-1), null);
  assert.equal(formatUnreadBadge(Number.NaN), null);
});

test("bell is always rendered; the badge only appears when unread > 0", () => {
  const none = render(0);
  assert.match(none, /href="\/notifications"/, "bell must be a real link (keyboard accessible)");
  assert.doesNotMatch(none, /notification-unread-badge/, "0 unread → no badge at all");
  assert.match(none, /aria-label="Notifikasi"/, "signed-in, nothing unread → plain label");

  const one = render(1);
  assert.match(one, /notification-unread-badge[^>]*>1</, 'unread 1 → badge "1"');
  assert.match(one, /aria-label="Notifikasi \(1 belum dibaca\)"/, "aria-label mentions the unread count");

  const many = render(140);
  assert.match(many, /notification-unread-badge[^>]*>99\+</, "unread >99 → badge \"99+\"");
  assert.match(many, /aria-label="Notifikasi \(99\+ belum dibaca\)"/);
});

test("bell exposes the unread count only through the authenticated API, never a dummy value", () => {
  assert.match(bell, /fetch\("\/api\/notifications"/, "the count comes from the server endpoint");
  assert.match(bell, /response\.status === 401/, "a signed-out answer yields no badge");
  assert.doesNotMatch(bell, /setInterval|setTimeout\(.*fetch|EventSource|WebSocket/i, "no polling and no realtime");
});

// --- Header placement (additive only) -------------------------------------

test("signed-out header has no notification action; signed-in header gains the bell", () => {
  // The bell lives in the authenticated branch only.
  assert.match(siteNav, /import NotificationBell from "\.\/notification-bell"/);
  const bellIndex = siteNav.indexOf("<NotificationBell />");
  const accountMenuIndex = siteNav.indexOf("<AccountMenu />");
  assert.ok(bellIndex > 0 && accountMenuIndex > bellIndex, "bell is added inside the signed-in branch, before the account menu");
  const signedInBranch = siteNav.slice(siteNav.indexOf("authenticated ? ("), siteNav.indexOf(": (", siteNav.indexOf("authenticated ? (")));
  assert.match(signedInBranch, /NotificationBell/, "bell is inside the authenticated branch");
  // Signed-out branch (Daftar/Masuk) is untouched.
  assert.match(siteNav, /href="\/auth\/sign-up"/);
  assert.match(siteNav, />\s*Masuk\s*</);
  // No existing nav item added, removed, or reordered.
  assert.match(siteNav, /isActiveNavSection\(pathname, "home"\)/);
  assert.match(siteNav, /isActiveNavSection\(pathname, "live"\)/);
  assert.match(siteNav, /isActiveNavSection\(pathname, "visit-intents"\)/);
  assert.match(siteNav, /href="\/live"/);
  assert.match(siteNav, /href="\/visit-intents"/);
  // Exactly one inbox destination in the whole header: the bell.
  assert.equal((siteNav.match(/href="\/notifications"/g) ?? []).length, 0, "the header links the bell, not a raw inbox URL");
});

test("the header keeps its existing shape: logo, nav links, and account menu unchanged", () => {
  assert.match(siteNav, /<BrandLogo height=\{40\} tagline="Temukan cerita di balik tempat" \/>/, "logo untouched");
  assert.match(siteNav, /aria-label="Navigasi utama"/);
  assert.match(siteNav, /<AccountMenu \/>/, "existing account menu still rendered");
});

// --- Account menu: settings entry, not a second inbox ---------------------

test("Setting → Notification Settings opens the settings page, not the inbox", () => {
  assert.match(accountMenu, /\{ label: "Notification Settings", href: "\/account\/notifications" \}/);
  assert.doesNotMatch(accountMenu, /href: "\/notifications"/, "no second inbox entry in the menu");
  assert.match(accountMenu, /role="menuitem"/, "the item is a real menu item (keyboard reachable)");
  // Existing setting items stay inert (no dead links invented).
  for (const label of ["Navigation", "App Language", "Video Setting"]) {
    assert.match(accountMenu, new RegExp(`\\{ label: "${label}" \\}`));
  }
});

// --- Inbox ----------------------------------------------------------------

test("inbox route is authenticated-only and reads the caller's own notifications", () => {
  assert.match(inboxPage, /export const dynamic = "force-dynamic"/);
  assert.match(inboxPage, /requireAuthenticatedActor\(new Request\("http:\/\/localhost\/notifications"\)\)/);
  assert.match(inboxPage, /redirect\("\/auth\?returnTo=%2Fnotifications"\)/, "signed-out → existing auth flow");
  assert.match(inboxPage, /listUserNotifications\(actor\.userId\)/, "identity from the session, not from input");
  // Newest first comes from the repository ordering, and clicking sets read_at.
  assert.match(inboxPage, /notification\.readAt === null/, "unread/read state is rendered");
  assert.match(inboxItem, /\/api\/notifications\/\$\{notification\.id\}\/read/, "opening marks it read server-side");
  assert.match(inboxItem, /setRead\(true\)/, "state only flips on the server's own response");
});

test("inbox only opens EXISTING routes (Place page), never a new Live route", () => {
  assert.equal(resolveNotificationHref({ placeId: "kopi-dari-kebun" }), "/places/kopi-dari-kebun");
  assert.equal(resolveNotificationHref({ placeId: null }), null, "no target → no invented destination");
  assert.equal(resolveNotificationHref({ placeId: "  " }), null);
  assert.doesNotMatch(inboxItem, /\/live\//, "no Live route is introduced by the inbox");
});

// --- Settings --------------------------------------------------------------

test("settings shows exactly the six locked categories with Safety & Account mandatory", () => {
  const categories = NOTIFICATION_CATEGORY_CATALOG.map((entry) => entry.category);
  assert.deepEqual(categories, [
    "live_place",
    "visit_experience",
    "help_support",
    "system",
    "safety_account",
    "promotional",
  ]);
  assert.equal(NOTIFICATION_CATEGORY_CATALOG.length, 6, "no additional category may appear");
  const safety = NOTIFICATION_CATEGORY_CATALOG.find((entry) => entry.category === "safety_account");
  assert.ok(safety?.mandatory && safety?.editable === false, "Safety & Account is mandatory and not editable");
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.safety_account, true);
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.promotional, false, "Promotional defaults OFF");
  for (const category of ["live_place", "visit_experience", "help_support", "system"] as const) {
    assert.equal(DEFAULT_NOTIFICATION_PREFERENCES[category], true, `${category} defaults ON`);
  }
});

test("settings page is authenticated, stores through the API, and is not the inbox", () => {
  assert.match(settingsPage, /requireAuthenticatedActor/);
  assert.match(settingsPage, /redirect\("\/auth\?returnTo=%2Faccount%2Fnotifications"\)/);
  assert.match(settingsPage, /readUserNotificationPreferences\(actor\.userId\)/, "renders from canonical stored state");
  assert.match(settingsForm, /method: "PATCH"/);
  assert.match(settingsForm, /\/api\/notification-preferences/);
  assert.match(settingsForm, /router\.refresh\(\)/, "a refresh re-reads the server state");
  // The mandatory category is never sent as a user choice.
  assert.doesNotMatch(settingsForm, /safety_account:\s*next\./, "the client must not toggle the mandatory category");
});

// --- Scope fences ----------------------------------------------------------

test("no schema, no new nav sections, and no unimplemented channels slipped in", () => {
  // No new migration / no client write access for notifications.
  assert.doesNotMatch(
    `${bell}${inboxPage}${settingsPage}${settingsForm}`,
    /supabase\.from\(["']notifications["']\)\.insert|\.from\(["']notifications["']\)\.delete/,
    "clients never create or delete notifications",
  );
  // Around/proximity, selected Place, push, email, SMS, realtime stay out.
  for (const file of [bell, inboxPage, inboxItem, settingsPage, settingsForm]) {
    assert.doesNotMatch(file, /geolocation|Around|dipilih|selected/i, "no Around/selected-Place scope");
    assert.doesNotMatch(file, /push|web-push|sendgrid|twilio|whatsapp|smtp/i, "no push/email/SMS delivery");
  }
});
