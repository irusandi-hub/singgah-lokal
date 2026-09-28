import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  experienceScheduleStatusLabel,
  experienceStatusLabel,
  productionStageStatusLabel,
  publicationStatusLabel,
  visitIntentStatusLabel,
  weekdayLabel,
} from "../lib/status-labels";

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

const dashboard = read("app/producer/page.tsx");
const workspace = read("app/producer/places/ProducerPlaceWorkspace.tsx");
const placeForm = read("app/producer/places/PlaceForm.tsx");
const claimPanel = read("app/producer/places/PlaceClaimPanel.tsx");
const placeDetail = read("app/producer/places/[placeId]/page.tsx");
const experiences = read("app/producer/places/[placeId]/experiences/page.tsx");
const experiencePanel = read("app/producer/places/[placeId]/experiences/ExperiencesPanel.tsx");
const experienceForm = read("app/producer/places/[placeId]/experiences/ExperienceForm.tsx");
const production = read("app/producer/places/[placeId]/production/page.tsx");
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
  assert.match(inbox, />Permintaan Kunjungan</);
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
  assert.match(placeForm, /publicationStatusLabel\(place\.publicationStatus\)/);
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

test("Common product words stay untranslated", () => {
  // Dashboard, Live, Draft and Status are already natural — keep them.
  assert.match(placeForm, /Status: /);
  assert.match(production, />Simpan draft</);
  assert.match(livePage, /Pengelola Live/);
  assert.match(liveConsole, /Mulai Live/);
});

test("Database-standard and English leftovers are gone from Producer copy", () => {
  assert.equal(placeForm.includes("Timezone IANA"), false);
  assert.equal(placeForm.includes("Currency ISO 4217"), false);
  assert.equal(experienceForm.includes("Requires confirmation"), false);
  assert.equal(experienceForm.includes("Jadwal ({placeTimezone})"), false);
  assert.equal(inboxDetail.includes("Party size"), false);
  assert.equal(inboxDetail.includes(">Timezone<"), false);
  assert.equal(production.includes(">Tambah stage<"), false);
  assert.equal(production.includes("/ Production Story"), false);
  assert.equal(liveConsole.includes("Proses (harus published)"), false);
  assert.equal(liveConsole.includes("Tidak ada Proses published"), false);
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
});
