import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * MOBILE DENSITY + TERMINOLOGY + ACCOUNT NAVIGATION (Tahap 3).
 *
 * Mobile-first decisions this suite locks:
 *  - at 360px AND 390px no touched surface may declare a FIXED width wider than
 *    the viewport, force horizontal scrolling, or prevent wrapping of user
 *    content (emails, Place names, usernames). The fix for a cramped layout was
 *    the STRUCTURE (grouping, subviews, wrapping rows), never a smaller font or
 *    a horizontal scroller;
 *  - the Indonesian wording stays consistent with
 *    docs/UI_TERMINOLOGY_STANDARD.md — no retired English label returns;
 *  - the account navigation surface stays as designed: ONE Profil Saya panel,
 *    ONE Akses list, and an account menu where every destination keeps its icon
 *    and the shared chevron.
 *
 * MEASUREMENT LIMITATION (honest): no headless browser (Playwright/Puppeteer)
 * exists in this repository, so `scrollWidth <= clientWidth` was NOT measured in
 * a real 360px/390px viewport. These are static structural checks, and the
 * browser measurement is reported as NOT-RUN.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const SURFACES: Readonly<Record<string, string>> = {
  "Profil Saya panel": read("../components/account/account-profile-client.tsx"),
  "Edit Profil screen": read("../components/account/account-profile-edit-client.tsx"),
  "Akun & Akses page": read("../app/account/page.tsx"),
  "Edit Profil page": read("../app/account/profile/page.tsx"),
  "Kelola Akses Live": read("../components/account/account-live-operator-manager.tsx"),
  "Undangan Operator Live": read("../components/account/operator-invitation-inbox.tsx"),
  "Notifikasi page": read("../app/notifications/page.tsx"),
  "Account menu": read("../components/account-menu.tsx"),
  // Every surface this pass TOUCHED is in the scan set, so a re-trim of a row
  // cannot silently reintroduce a fixed width or a forced scroller.
  "Operator Live rows": read("../components/account/account-live-access-client.tsx"),
  "Account icons": read("../components/account/account-icons.tsx"),
};

/** Every literal className value (static string or interpolation-free template). */
function classNames(source: string): string[] {
  const found = [
    ...source.matchAll(/className="([^"]*)"/g),
    ...source.matchAll(/className=\{`([^`]*?)`\}/g),
  ];
  return found.map((match) => match[1]);
}

/** Tailwind spacing steps of 10+ (40px and up) are needless mobile emptiness. */
const EXCESSIVE_SPACING =
  /\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y)-(?:1[0-9]|[2-9][0-9])\b/;

function violations(source: string, viewport: number, sourceName: string): string[] {
  const problems: string[] = [];
  for (const className of classNames(source)) {
    // Fixed widths must fit the narrowest viewport we design for.
    for (const match of className.matchAll(/\b(?:min-)?w-\[(\d+)px\]/g)) {
      const width = Number(match[1]);
      if (width > viewport) {
        problems.push(`${sourceName}: fixed width w-[${width}px] exceeds ${viewport}px`);
      }
    }
    if (/\boverflow-x-(auto|scroll)\b/.test(className)) {
      problems.push(`${sourceName}: overflow-x scroller (${className})`);
    }
    if (/\bwhitespace-nowrap\b/.test(className)) {
      problems.push(`${sourceName}: whitespace-nowrap prevents wrapping (${className})`);
    }
    if (EXCESSIVE_SPACING.test(className)) {
      problems.push(`${sourceName}: excessive spacing (${className})`);
    }
  }
  for (const match of source.matchAll(/style=\{\{[^}]*width:\s*(\d+)/g)) {
    if (Number(match[1]) > viewport) {
      problems.push(`${sourceName}: inline width ${match[1]}px exceeds ${viewport}px`);
    }
  }
  return problems;
}

test("the density checker itself detects a violation (self-check)", () => {
  // A checker that can never fail proves nothing, so it is exercised first.
  const synthetic =
    '<div className="w-[420px] overflow-x-auto whitespace-nowrap mt-12" style={{ width: 400 }} />';
  assert.deepEqual(violations(synthetic, 360, "synthetic"), [
    "synthetic: fixed width w-[420px] exceeds 360px",
    "synthetic: overflow-x scroller (w-[420px] overflow-x-auto whitespace-nowrap mt-12)",
    "synthetic: whitespace-nowrap prevents wrapping (w-[420px] overflow-x-auto whitespace-nowrap mt-12)",
    "synthetic: excessive spacing (w-[420px] overflow-x-auto whitespace-nowrap mt-12)",
    "synthetic: inline width 400px exceeds 360px",
  ]);
  // ...and accepts a compliant row.
  assert.deepEqual(
    violations('<div className="w-full min-w-0 break-words mt-4 gap-2" />', 360, "ok"),
    [],
  );
});

test("no touched surface overflows at 360px or 390px", () => {
  for (const viewport of [360, 390]) {
    for (const [name, source] of Object.entries(SURFACES)) {
      assert.deepEqual(violations(source, viewport, name), [], `viewport ${viewport}px`);
    }
  }
});

test("user content is allowed to wrap instead of being clipped", () => {
  const wrapping = ["Profil Saya panel", "Edit Profil screen", "Kelola Akses Live", "Undangan Operator Live"];
  for (const name of wrapping) {
    const source = SURFACES[name];
    assert.ok(
      (source.match(/break-words/g) ?? []).length >= 3,
      `${name} must let long names/emails/Place names wrap`,
    );
  }
  for (const name of ["Kelola Akses Live", "Undangan Operator Live", "Profil Saya panel"]) {
    assert.ok(
      (SURFACES[name].match(/(?:^|["\s])min-w-0/g) ?? []).length >= 2,
      `${name} must use min-w-0 inside flex rows`,
    );
  }
  // Rows wrap rather than pushing a badge or an action out of the viewport.
  assert.ok((SURFACES["Kelola Akses Live"].match(/flex-wrap/g) ?? []).length >= 4);
  assert.ok((SURFACES["Undangan Operator Live"].match(/flex-wrap/g) ?? []).length >= 3);
});

test("compact controls replace the old fixed-width layout", () => {
  assert.match(SURFACES["Kelola Akses Live"], /<select/, "one Place picker, no wide table");
  assert.match(SURFACES["Kelola Akses Live"], /grid-cols-2/, "the subview switch fits two columns at 360px");
  assert.match(SURFACES["Kelola Akses Live"], /max-w-sm/, "the confirmation dialog shrinks to the viewport");
  assert.match(
    SURFACES["Account menu"],
    /max-w-\[calc\(100vw-1\.5rem\)\]/,
    "the open menu can never exceed the screen",
  );
  assert.doesNotMatch(SURFACES["Akun & Akses page"], /<table|min-w-\[/, "no wide fixed table on the account page");
});

test("the new surfaces reuse the shared UI kit instead of local styling systems", () => {
  for (const name of ["Profil Saya panel", "Edit Profil screen", "Kelola Akses Live", "Undangan Operator Live"]) {
    assert.match(SURFACES[name], /from "@\/components\/ui\/kit"/, `${name} must reuse the shared kit`);
  }
  assert.match(SURFACES["Edit Profil screen"], /<Panel/, "groups sit on the shared Panel");
  assert.match(SURFACES["Undangan Operator Live"], /<Section/, "the invitee block is a shared Section");
  assert.match(SURFACES["Kelola Akses Live"], /StatusBadge/, "statuses use the shared badge");
  assert.match(SURFACES["Akun & Akses page"], /<ListRow/, "access rows reuse the shared list row");
});

test("Indonesian labels stay consistent and retired English labels do not return", () => {
  const accountPage = SURFACES["Akun & Akses page"];
  for (const label of ["Akun & Akses", "Profil Saya", "Akses", "Kembali ke Beranda|← Beranda"]) {
    assert.match(accountPage, new RegExp(label), `account page keeps ${label}`);
  }
  for (const [name, source] of Object.entries(SURFACES)) {
    assert.doesNotMatch(
      source,
      /\bSave\b|\bCancel\b|\bSubmit\b|\bSettings\b|\bRevoke\b|\bInvite\b|\bAccount Center\b/,
      `${name} must not reintroduce a retired English label`,
    );
  }
  // The locked actions of the new screens.
  assert.match(SURFACES["Edit Profil screen"], />\s*Simpan/, "the save action is Simpan");
  assert.match(SURFACES["Edit Profil screen"], /Batal/, "the cancel action is Batal");
  assert.match(SURFACES["Profil Saya panel"], /Edit Profil/);
  assert.match(SURFACES["Notifikasi page"], /Pengaturan Notifikasi/);
  assert.doesNotMatch(SURFACES["Notifikasi page"], /Notification Settings/);
  assert.match(SURFACES["Kelola Akses Live"], /Operator Live/);
  assert.match(SURFACES["Kelola Akses Live"], /Tempat/, "the user-facing word for Place is kept");
});

test("the account navigation surface is unchanged in shape", () => {
  const accountPage = SURFACES["Akun & Akses page"];
  assert.equal((accountPage.match(/<Section title="Profil Saya">/g) ?? []).length, 1);
  assert.equal((accountPage.match(/<Section title="Akses">/g) ?? []).length, 1);
  assert.doesNotMatch(accountPage, /<Section title="Keamanan">/);
  assert.doesNotMatch(accountPage, /\/producer\/places/);

  const menu = SURFACES["Account menu"];
  for (const label of [
    "Kelola Akun",
    "Akun & Akses",
    "Keluar",
    "Pengaturan",
    "Navigasi",
    "Bahasa Aplikasi",
    "Pengaturan Video",
    "Pengaturan Notifikasi",
    "Bantuan",
    "Tentang",
  ]) {
    assert.ok(menu.includes(label), `account menu keeps ${label}`);
  }
  // One entry per destination, and the destinations are icons + chevron rows.
  assert.equal((menu.match(/href: "\/account\/notifications"/g) ?? []).length, 1);
  assert.equal((menu.match(/href: "\/notifications"/g) ?? []).length, 0);
  assert.match(menu, /ChevronIcon/, "navigating rows carry the shared chevron");
  assert.equal((menu.match(/MENU_GROUPS\[1\]/g) ?? []).length, 0, "no duplicated group markup");
  assert.match(menu, /MENU_GROUPS\.map\(/, "the grouped list is rendered from ONE data array");
});
