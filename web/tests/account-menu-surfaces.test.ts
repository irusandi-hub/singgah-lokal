import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

/**
 * Account menu surface audit — Setting / Help / About & Terms.
 *
 * This audit (see docs/ACCOUNT_MENU_GAP_AUDIT.md) found NO product
 * source-of-truth for the remaining items, so the honest existing behaviour
 * is preserved instead of invented content:
 * - Navigation / App Language / Video Setting: no master requirement, no
 *   stored preference, no second locale, no user-facing video control
 *   (MASTER 01 locks Bahasa Indonesia as the initial single language;
 *   MASTER 10 keeps localization architectural; MASTER_LIVE_POLICY §6 locks
 *   720p/30 fps as a technical Live limit, not a user setting);
 * - Help: no FAQ/contact/support copy anywhere (MASTER 10's "Help & Support"
 *   is a notification CATEGORY, MASTER 08/09's Support/Ops is an internal
 *   Platform Admin role);
 * - About & Terms: no Terms/Privacy/legal copy in the project; MASTER 12
 *   defers privacy/retention to a "Privacy Master" that does not exist here.
 *
 * These tests lock that state: no invented route, no dead link, no duplicate
 * notification entry, and no change to the existing header navigation.
 */

const menu = readFileSync(new URL("../components/account-menu.tsx", import.meta.url), "utf8");
const siteNav = readFileSync(new URL("../components/site-nav.tsx", import.meta.url), "utf8");
const bell = readFileSync(new URL("../components/notification-bell.tsx", import.meta.url), "utf8");
const settingsPage = readFileSync(new URL("../app/account/notifications/page.tsx", import.meta.url), "utf8");
const inboxPage = readFileSync(new URL("../app/notifications/page.tsx", import.meta.url), "utf8");

const routeExists = (relative: string) => existsSync(new URL(relative, import.meta.url));

function menuHrefs(): string[] {
  return [...menu.matchAll(/href: "([^"]+)"/g)].map((match) => match[1]);
}

// --- A. Setting ------------------------------------------------------------

test("Setting keeps exactly the four audited items in the locked order", () => {
  const settingBlock = menu.slice(menu.indexOf('id: "setting"'), menu.indexOf("];", menu.indexOf('id: "setting"')));
  for (const label of ["Navigation", "App Language", "Video Setting", "Notification Settings"]) {
    assert.ok(settingBlock.includes(label), `Setting must keep ${label}`);
  }
  const order = ["Navigation", "App Language", "Video Setting", "Notification Settings"].map((label) =>
    settingBlock.indexOf(label),
  );
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "Setting item order is unchanged");
});

test("Notification Settings is the ONLY implemented Setting route — the rest stay inert", () => {
  // No source-of-truth exists for the other three, so they must NOT have
  // become links to invented surfaces (an inert item is the project's honest
  // pattern for a missing surface, not a dead link).
  const settingBlock = menu.slice(menu.indexOf('id: "setting"'), menu.indexOf("];", menu.indexOf('id: "setting"')));
  const linked = [...settingBlock.matchAll(/href: "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(linked, ["/account/notifications"], "Notification Settings is the only linked Setting item");
  for (const label of ["Navigation", "App Language", "Video Setting"]) {
    assert.match(
      settingBlock,
      new RegExp(`\\{ label: "${label}" \\}`),
      `${label} stays without an href (no invented route)`,
    );
  }
  assert.match(menu, /aria-disabled="true"[\s\S]*Segera tersedia/, "inert items stay visibly inert, not dead links");
});

// --- B. Help ---------------------------------------------------------------

test("Help stays an inert entry: no FAQ, contact, or support policy is invented", () => {
  assert.match(menu, />\s*Help\s*</, "Help entry still exists");
  assert.doesNotMatch(menu, /href: "\/help"/, "no invented help route");
  assert.match(menu, /role="menuitem" aria-disabled="true" title="Segera tersedia">\s*Help/, "Help is inert like the other pending items");
  for (const forbidden of ["faq", "hubungi", "kontak", "support@", "cs@", "whatsapp"]) {
    assert.doesNotMatch(menu.toLowerCase(), new RegExp(forbidden), `no invented ${forbidden} content`);
  }
  assert.equal(routeExists("../app/help/page.tsx"), false, "no empty Help route was created");
});

// --- C. About & Terms ------------------------------------------------------

test("About & Terms keeps its existing behaviour and invents no legal surface", () => {
  assert.match(menu, /About &amp; Terms|About & Terms/, "entry still exists");
  for (const route of ["../app/about/page.tsx", "../app/terms/page.tsx", "../app/privacy/page.tsx"]) {
    assert.equal(routeExists(route), false, "no legal page was invented without a Privacy/Terms master");
  }
  for (const invented of ["effective date", "berlaku sejak", "data processing agreement", "cookies", "garansi", "warranty"]) {
    assert.doesNotMatch(menu.toLowerCase(), new RegExp(invented), `no invented legal copy (${invented})`);
  }
});

// --- D. Menu structure / no duplicates -------------------------------------

test("menu structure stays: Account, Setting, Help, About & Terms — no duplicate entries", () => {
  assert.match(menu, /label: "Kelola Akun"/);
  assert.match(menu, /label: "Setting"/);
  for (const expected of ["Account Center", "Sign Out", "Setting", "Help", "About & Terms"]) {
    assert.ok(menu.includes(expected), `menu must contain ${expected}`);
  }
  // No second notification entry: the menu links the settings page only.
  const hrefs = menuHrefs();
  assert.equal(hrefs.filter((href) => href === "/account/notifications").length, 1, "exactly one Notification Settings entry");
  assert.equal(hrefs.filter((href) => href === "/notifications").length, 0, "no inbox entry inside the menu (the bell owns it)");
});

// --- E. Notification no-regression ----------------------------------------

test("Notification implementation is untouched: bell = inbox, menu = preferences", () => {
  assert.match(bell, /href="\/notifications"/, "the bell is the single inbox entry point");
  assert.match(settingsPage, /Notification Settings/);
  assert.match(settingsPage, /readUserNotificationPreferences/);
  assert.match(inboxPage, /requireAuthenticatedActor/, "inbox stays authenticated-only");
  assert.match(siteNav, /<NotificationBell \/>/, "bell still mounted in the header");
});

// --- F. Header stays clean -------------------------------------------------

test("header keeps its existing navigation: no added Home/LIVE/Visit Intent, no bottom nav", () => {
  assert.equal((siteNav.match(/<nav /g) ?? []).length, 1, "still exactly one header nav");
  const navBlock = siteNav.slice(siteNav.indexOf('aria-label="Navigasi utama"'), siteNav.indexOf("</nav>"));
  assert.equal((navBlock.match(/<Link/g) ?? []).length, 3, "nav still has exactly three links: Home, LIVE, Visit Intent");
  for (const section of ["home", "live", "visit-intents"]) {
    assert.match(navBlock, new RegExp(`isActiveNavSection\\(pathname, "${section}"\\)`), `${section} is still in the header nav`);
  }
  assert.doesNotMatch(navBlock, /href="\/notifications"/, "the inbox is not a header nav link — the bell owns it");
  assert.doesNotMatch(siteNav, /fixed bottom-0|inset-x-0 bottom-0/, "no bottom navigation was added");
  assert.match(siteNav, /<BrandLogo height=\{40\} tagline="Temukan cerita di balik tempat" \/>/, "logo untouched");
});

test("signed-out header has no account menu and no notification action", () => {
  const authedStart = siteNav.indexOf("authenticated ? (");
  const signedOutStart = siteNav.indexOf(") : (", authedStart);
  const authedBlock = siteNav.slice(authedStart, signedOutStart);
  const signedOutBlock = siteNav.slice(signedOutStart, siteNav.indexOf("</div>", signedOutStart));
  assert.match(authedBlock, /<AccountMenu \/>/, "signed-in branch owns the account menu");
  assert.match(authedBlock, /<NotificationBell \/>/, "signed-in branch owns the bell");
  assert.doesNotMatch(signedOutBlock, /AccountMenu|NotificationBell/, "signed-out branch has neither");
  assert.match(signedOutBlock, /href="\/auth"/, "signed-out keeps Masuk");
});
