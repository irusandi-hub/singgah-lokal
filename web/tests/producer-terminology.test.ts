import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  experienceScheduleStatusLabel,
  experienceStatusLabel,
  placeTypeLabel,
  productionStageStatusLabel,
  publicationStatusLabel,
  visitIntentStatusLabel,
  weekdayLabel,
} from "../lib/status-labels";
import { formatPlaceDate, timezoneLabel } from "../lib/display-format";
import { PLACE_CURRENCY_LABELS } from "../lib/places";

/**
 * PRODUCER UI LANGUAGE.
 *
 * Two rules, both locked here:
 * 1. the dictionary — Place→Tempat, Producer→Pengelola, published→Tayang,
 *    Kunjungan Inbox→Permintaan Kunjungan, and the workspace entry labels;
 * 2. no raw database value ever reaches the Producer UI. The stored enums stay
 *    exactly as they are (API, DB, comparisons); only the rendered label
 *    changes. "Dashboard", "Live", "Draft" and "Status" stay untranslated
 *    because they are already common product words.
 */

function read(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

/** Comments explain the code; they are never rendered, so they are ignored. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const dashboard = read("app/producer/page.tsx");
const workspace = read("app/producer/places/ProducerPlaceWorkspace.tsx");
const placeForm = read("app/producer/places/PlaceForm.tsx");
const claimPanel = read("app/producer/places/PlaceClaimPanel.tsx");
const placeDetail = read("app/producer/places/[placeId]/page.tsx");
// The Place workspace owns the rendered Place surface (UI/UX restructure
// 2026-10-08): the Place name, the one status row and the four items live here.
const placeWorkspace = read("app/producer/places/[placeId]/PlaceWorkspace.tsx");
const experiences = read("app/producer/places/[placeId]/experiences/page.tsx");
const experiencePanel = read("app/producer/places/[placeId]/experiences/ExperiencesPanel.tsx");
const experienceForm = read("app/producer/places/[placeId]/experiences/ExperienceForm.tsx");
// "Dari Sini" is now the fourth item of the Place workspace; its rendered
// surface is the panel, and the route is a thin workspace entry point.
const production = read("app/producer/places/[placeId]/production/ProductionStoryPanel.tsx");
const livePage = read("app/producer/live/page.tsx");
const liveConsole = read("app/producer/live/LiveConsole.tsx");
const inbox = read("app/producer/visit-intents/Inbox.tsx");
const inboxDetail = read("app/producer/visit-intents/[id]/VisitIntentDetail.tsx");
const onboarding = read("app/producer/onboarding/page.tsx");
const subNav = read("components/producer-sub-nav.tsx");

const producerSurfaces: Array<[string, string]> = [
  ["dashboard", dashboard],
  ["workspace", workspace],
  ["place form", placeForm],
  ["claim panel", claimPanel],
  ["place detail", placeDetail],
  ["place workspace", placeWorkspace],
  ["experiences page", experiences],
  ["experiences panel", experiencePanel],
  ["experience form", experienceForm],
  ["production", production],
  ["live page", livePage],
  ["live console", liveConsole],
  ["inbox", inbox],
  ["inbox detail", inboxDetail],
  ["onboarding", onboarding],
  ["sub nav", subNav],
];

/** Wording the previous dictionary used and this one replaces. */
const PLACE_WORD = "T" + "empat";
const CLAIM_DESCRIPTION = `Ajukan akses untuk mengelola ${PLACE_WORD} yang sudah ada di SINGGAH LOKAL.`;
const RETIRED = {
  inboxTitle: "Kunjungan Inbox",
  rosterHeading: "Tempat milikmu",
  addAction: `Tambahkan ${PLACE_WORD} baru`,
  addDescription: "Tampilkan proses produksi di SINGGAH LOKAL.",
  claimAction: `Klaim ${PLACE_WORD} yang Sudah Ada`,
  claimDescription: `Ajukan kepemilikan untuk ${PLACE_WORD} yang sudah ada di SINGGAH LOKAL.`,
  liveTitle: "Tampilkan proses produksi secara real-time.",
} as const;

test("The dictionary is applied across the Producer area", () => {
  assert.match(subNav, /label: "Permintaan Kunjungan"/);
  assert.match(inbox, /title="Permintaan Kunjungan"|>Permintaan Kunjungan</);
  assert.match(inboxDetail, /← Kembali ke Permintaan Kunjungan/);
  assert.match(onboarding, /Dashboard, Tempat, Permintaan Kunjungan, dan Live/);

  assert.match(workspace, /Tempat yang Kamu Kelola/);
  assert.match(workspace, />Tambahkan Tempat</);
  assert.match(workspace, /Bagikan kegiatan dan proses yang berlangsung di Tempatmu\./);
  assert.match(workspace, /Ajukan Pengelolaan Tempat/);
  assert.ok(workspace.includes(CLAIM_DESCRIPTION), "the claim entry must use the new description");

  assert.match(inbox, /Lihat permintaan kunjungan dan berikan tanggapan\./);
  assert.match(livePage, /Tampilkan proses yang sedang berlangsung secara langsung\./);
});

test("The final Producer copy pass is applied and its old wording is gone", () => {
  // The roster state owns the page header (UI/perf pass 2026-10-08: the
  // dashboard page is a thin loader and declares no chrome of its own).
  assert.match(workspace, /Kelola Tempat dan kegiatanmu, tanggapi Permintaan Kunjungan, dan kelola Live\./);
  assert.equal(workspace.includes("Kelola Tempat, Kegiatan, Kunjungan, dan Live"), false);

  // The shared nav is a pure menu: the escape link lives on the page, once
  // (UI/UX restructure 2026-10-08).
  assert.equal(subNav.includes("Kembali ke beranda"), false);
  assert.equal(subNav.includes("← Area user"), false);

  // "Kelola Proses" is the fourth item of the Place workspace, labelled once.
  assert.match(placeWorkspace, /label: "Kelola Proses"/);
  assert.equal(placeWorkspace.includes("Kelola Dari Sini"), false, "must not say \"Kelola Dari Sini\"");
  // The public terminology of the surface itself stays "Dari Sini".
  assert.match(production, /Dari Sini/);

  for (const [name, code] of [
    ["workspace", workspace],
    ["claim panel", claimPanel],
  ] as const) {
    assert.match(code, /Kembali ke Tempat/, `${name} must return to the Place list`);
    assert.equal(code.includes("Kembali ke daftar"), false, `${name} must not say "Kembali ke daftar"`);
  }
});

test("The retired dictionary wording is gone from the Producer area", () => {
  for (const [name, code] of producerSurfaces) {
    for (const retired of [
      RETIRED.inboxTitle,
      RETIRED.rosterHeading,
      RETIRED.addAction,
      RETIRED.claimAction,
      RETIRED.addDescription,
      RETIRED.claimDescription,
      RETIRED.liveTitle,
    ]) {
      assert.equal(code.includes(retired), false, `${name} must not say "${retired}"`);
    }
  }
});

test("No raw database status ever reaches the Producer UI", () => {
  // Every rendered status goes through the shared label module.
  assert.match(workspace, /publicationStatusLabel\(place\.publicationStatus\)/);
  assert.match(placeWorkspace, /publicationStatusLabel\(place\.publicationStatus\)/);
  assert.match(experiencePanel, /experienceStatusLabel\(experience\.status\)/);
  assert.match(experienceForm, /experienceStatusLabel\(experience\.status\)/);
  assert.match(production, /productionStageStatusLabel\(stage\.status\)/);
  assert.match(inbox, /visitIntentStatusLabel\(intent\.status\)/);
  assert.match(inboxDetail, /visitIntentStatusLabel\(intent\.status\)/);

  // Nothing renders a stored status/enum value directly any more.
  const forbidden: Array<[string, string]> = [
    ["workspace", "{place.publicationStatus}"],
    ["workspace", "{view.place.publicationStatus}"],
    ["place form", "{place.publicationStatus}"],
    ["place workspace", "{place.publicationStatus}"],
    ["experiences panel", "{experience.status}"],
    ["experience form", "{experience.status}"],
    ["production", "{stage.status}"],
    ["inbox", "{intent.status}"],
    ["inbox detail", "{intent.status}"],
    ["inbox", ">{item}</option>"],
  ];
  const sources: Record<string, string> = {
    workspace,
    "place form": placeForm,
    "place workspace": placeWorkspace,
    "experiences panel": experiencePanel,
    "experience form": experienceForm,
    production,
    inbox,
    "inbox detail": inboxDetail,
  };
  for (const [name, needle] of forbidden) {
    assert.equal(sources[name].includes(needle), false, `${name} must not render ${needle}`);
  }
});

test("No stored role or membership jargon reaches the Producer UI", () => {
  // Comments are not user-facing; only the rendered copy is checked.
  const liveCode = stripComments(livePage);
  const onboardingCode = stripComments(onboarding);
  assert.equal(liveCode.includes("owner/manager"), false, "the Live empty state must not name a stored role");
  assert.match(liveCode, /hak akses Pengelola/);
  assert.equal(onboardingCode.includes("owner/manager"), false, "the application steps must not name a stored role");
  assert.equal(onboardingCode.includes("membership Pengelola"), false);
  assert.match(onboardingCode, /hak akses Pengelola untuk akun yang mengaju\./);
});

test("Common product words stay untranslated", () => {
  // Dashboard, Live, Draft and Status are already natural — keep them.
  assert.match(production, /Status: /);
  assert.match(production, />Simpan draft</);
  assert.match(livePage, /Pengelola Live/);
  assert.match(liveConsole, /Mulai Live/);
});

test("Database-standard and English leftovers are gone from Producer copy", () => {
  // Currency keeps its name as a SELECT over the canonical IDR/USD
  // vocabulary (PO, 2026-09-28); Latitude/Longitude are no longer typed at
  // all — coordinates come only from the map picker, and the timezone is
  // resolved server-side from them (no timezone control in the form).
  assert.doesNotMatch(placeForm, /\["timezone", "Timezone"\]/);
  assert.doesNotMatch(placeForm, />Latitude</);
  assert.doesNotMatch(placeForm, />Longitude</);
  assert.doesNotMatch(placeForm, /\["currency", "Currency"\]/);
  // The two option labels are now rendered from the ONE canonical currency
  // rule (`APPLICATION_CURRENCIES` + `PLACE_CURRENCY_LABELS`) instead of a
  // second hand-written list, so the wording is asserted where it now lives —
  // byte-identical to what the form showed before.
  assert.match(placeForm, /APPLICATION_CURRENCIES\.map\(/);
  assert.match(placeForm, /PLACE_CURRENCY_LABELS\[currency\]/);
  assert.equal(PLACE_CURRENCY_LABELS.IDR, "IDR \u2014 Rupiah Indonesia");
  assert.equal(PLACE_CURRENCY_LABELS.USD, "USD \u2014 Dolar Amerika Serikat");
  assert.equal(placeForm.includes("Zona waktu"), false);
  assert.equal(placeForm.includes("Mata uang"), false);

  assert.equal(experienceForm.includes("Requires confirmation"), false);
  assert.equal(inboxDetail.includes("Party size"), false);
  assert.equal(inboxDetail.includes("Zona waktu"), false);
  assert.equal(production.includes(">Tambah stage<"), false);
  assert.equal(production.includes("/ Production Story"), false);
  assert.equal(liveConsole.includes("Proses (harus published)"), false);
  assert.equal(liveConsole.includes("Tidak ada Proses published"), false);
});

test("Dates and timezones read as dates and places, not as stored values", () => {
  // The stored values never change; only how they are rendered.
  assert.match(inbox, /formatPlaceDate\(intent\.requestedDate\)/);
  assert.match(inbox, /timezoneLabel\(intent\.timezone\)/);
  assert.equal(inbox.includes("{intent.timezone}"), false, "no raw IANA id in the inbox card");
  assert.match(inboxDetail, /formatPlaceDate\(intent\.requestedDate\)/);
  assert.equal(inboxDetail.includes("{intent.timezone}"), false, "no raw IANA id in the detail");
  assert.match(experienceForm, /Jadwal \(Timezone: \{timezoneLabel\(placeTimezone\)\}\)/);
  assert.equal(experienceForm.includes("Jadwal ({placeTimezone})"), false);

  // A Place type is a stored enum, so the claim surface labels it too.
  assert.match(claimPanel, /placeTypeLabel\(claim\.type\)/);
  assert.match(claimPanel, /placeTypeLabel\(selected\.type\)/);
});

test("The display formatters are safe for any stored value", () => {
  assert.equal(formatPlaceDate("2026-04-01"), "1 Apr 2026");
  assert.equal(formatPlaceDate("2026-12-25"), "25 Des 2026");
  // Anything unexpected is passed through rather than mangled.
  assert.equal(formatPlaceDate("besok"), "besok");
  assert.equal(formatPlaceDate("2026-13-45"), "2026-13-45");

  assert.equal(timezoneLabel("Asia/Jakarta"), "Jakarta");
  assert.equal(timezoneLabel("America/New_York"), "New York");
  assert.equal(timezoneLabel("Asia/Makassar"), "Makassar");
  assert.equal(timezoneLabel(""), "");
});

test("The kept terms survive across the Producer area", () => {
  // Live, Dashboard and Draft are common product words.
  assert.match(liveConsole, /Mulai Live/);
  assert.match(placeWorkspace, /← Pengelola/);
  assert.match(production, /Status: /);
  assert.match(production, />Simpan draft</);
  // "User" never reaches the Producer UI.
  for (const [name, code] of producerSurfaces) {
    assert.doesNotMatch(code, />[^<]*\bUser\b[^<]*</, `${name} must not say "User"`);
  }
});

test("The label module maps every stored value to Indonesian", () => {
  assert.equal(publicationStatusLabel("published"), "Tayang");
  assert.equal(publicationStatusLabel("draft"), "Draft");
  assert.equal(publicationStatusLabel("paused"), "Jeda");
  assert.equal(publicationStatusLabel("archived"), "Diarsipkan");

  assert.equal(experienceStatusLabel("published"), "Tayang");

  assert.equal(experienceScheduleStatusLabel("available"), "Tersedia");
  assert.equal(experienceScheduleStatusLabel("not_available"), "Tidak tersedia");
  assert.equal(experienceScheduleStatusLabel("requires_confirmation"), "Perlu konfirmasi");

  assert.equal(productionStageStatusLabel("review"), "Ditinjau");
  assert.equal(productionStageStatusLabel("published"), "Tayang");

  assert.equal(visitIntentStatusLabel("pending"), "Menunggu");
  assert.equal(visitIntentStatusLabel("accepted"), "Diterima");
  assert.equal(visitIntentStatusLabel("declined"), "Ditolak");
  assert.equal(visitIntentStatusLabel("requires_confirmation"), "Perlu konfirmasi");
  assert.equal(visitIntentStatusLabel("cancelled"), "Dibatalkan");
  assert.equal(visitIntentStatusLabel("expired"), "Kedaluwarsa");

  assert.equal(weekdayLabel("Monday"), "Senin");
  assert.equal(weekdayLabel("Sunday"), "Minggu");

  assert.equal(placeTypeLabel("production"), "Produksi");
  assert.equal(placeTypeLabel("experience"), "Kegiatan");
  assert.equal(placeTypeLabel("Sesuatu"), "Sesuatu");
});
