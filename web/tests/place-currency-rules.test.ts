import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  APPLICATION_CURRENCIES,
  PLACE_CURRENCIES,
  PLACE_CURRENCY_LABELS,
  isApplicationCurrency,
  placeCurrencyLabel,
} from "../lib/places";
import { assertApplicationCurrency, parsePlaceMutation, PlaceInputError } from "../lib/place-management";

/**
 * EXECUTABLE currency rules.
 *
 * The governance problem this locks shut: SINGGAH LOKAL works in IDR and USD
 * only, yet a stored Place may legitimately carry SAR (migration 0039 + MASTER
 * DEVELOPER AUTHORITY & DUMMY PLACE v1.0 §7, so a Place can always satisfy
 * "Currency follows Place" for its own geography). Those are two DIFFERENT
 * rules, and the original suite asserted the second against the first — which
 * is exactly how a stale expectation survived in the test suite. Both rules are
 * pinned here, separately, so neither can drift into the other again.
 */

const validInput = {
  id: "place-mata-uang",
  name: "Tempat Mata Uang",
  shortDescription: "Cerita lokal",
  category: "Sumber Daya Alam",
  type: "production",
  area: "Bandung",
  countryCode: "ID",
  regionName: "Jawa Barat",
  address: "Jalan Lokal 1",
  contactInformation: "hello@example.test",
  timezone: "Asia/Jakarta",
  currency: "IDR",
  latitude: -6.9,
  longitude: 107.6,
};

const producerCreateRoute = readFileSync(
  new URL("../app/api/producer/places/route.ts", import.meta.url),
  "utf8",
);
const producerUpdateRoute = readFileSync(
  new URL("../app/api/producer/places/[placeId]/route.ts", import.meta.url),
  "utf8",
);

// ---------------------------------------------------------------------------
// The APPLICATION rule — what the platform itself works in.
// ---------------------------------------------------------------------------

test("the application supports exactly IDR and USD", () => {
  assert.deepEqual([...APPLICATION_CURRENCIES], ["IDR", "USD"]);
});

test("IDR and USD pass the application currency rule", () => {
  for (const supported of APPLICATION_CURRENCIES) {
    assert.equal(isApplicationCurrency(supported), true, `${supported} is supported`);
    assert.doesNotThrow(() => assertApplicationCurrency(supported));
  }
});

test("SAR is refused by the application currency rule, even though it is a legal stored value", () => {
  // The exact case the SAR failure was about. SAR is admitted to
  // `places.currency` on purpose; the platform still refuses to work in it.
  assert.equal(isApplicationCurrency("SAR"), false);
  assert.throws(() => assertApplicationCurrency("SAR"), PlaceInputError);
  assert.throws(() => assertApplicationCurrency("SAR"), /place_currency_invalid/);
});

test("other unsupported currencies are refused the same way — no lenient branch", () => {
  const unsupported = ["EUR", "SGD", "JPY", "MYR", "GBP", "AUD", "SAR ", " sar", "IDRX", "", "ID"];
  for (const currency of unsupported) {
    assert.equal(isApplicationCurrency(currency), false, `${JSON.stringify(currency)} is not supported`);
    assert.throws(
      () => assertApplicationCurrency(currency),
      /place_currency_invalid/,
      `${JSON.stringify(currency)} must be refused`,
    );
  }
});

test("the application rule never throws on a non-string input", () => {
  // The guard runs on a server boundary: a malformed value must be refused, not
  // crash the request handler.
  for (const value of [null, undefined, 0, 1, {}, [], true, Symbol("idr")]) {
    assert.equal(isApplicationCurrency(value), false);
  }
});

// ---------------------------------------------------------------------------
// The STORED rule — what a `places.currency` column may hold.
// ---------------------------------------------------------------------------

test("the stored vocabulary mirrors the applied database CHECK (0033 widened by 0039)", () => {
  assert.deepEqual([...PLACE_CURRENCIES], ["IDR", "USD", "SAR"]);
});

test("a Place that legitimately carries SAR can still be written and read", () => {
  // A DEV-only test Place in its own geography must be saveable, otherwise the
  // Admin could never maintain it — the exact defect the duplicated validator
  // list caused before this rule was separated.
  const mutation = parsePlaceMutation({
    ...validInput,
    countryCode: "SA",
    regionName: "Ash Sharqiyah",
    timezone: "Asia/Riyadh",
    currency: "sar",
    latitude: 24.6937,
    longitude: 46.6853,
  });
  assert.equal(mutation.currency, "SAR");
});

test("the stored vocabulary still refuses every unsupported code", () => {
  for (const invalid of ["EUR", "SGD", "JPY", "us", "IDRX", "US"]) {
    assert.throws(
      () => parsePlaceMutation({ ...validInput, currency: invalid }),
      /place_currency_invalid/,
      `stored currency "${invalid}" must be refused`,
    );
  }
  // A missing/blank currency fails earlier, in the shared required-field check,
  // so it is refused as well — never defaulted into a currency.
  for (const blank of ["", "   "]) {
    assert.throws(
      () => parsePlaceMutation({ ...validInput, currency: blank }),
      /place_required_field_invalid/,
      `stored currency ${JSON.stringify(blank)} must be refused`,
    );
  }
});

test("currency codes are normalised by trimming and upper-casing only", () => {
  assert.equal(parsePlaceMutation({ ...validInput, currency: "idr" }).currency, "IDR");
  assert.equal(parsePlaceMutation({ ...validInput, currency: "Usd" }).currency, "USD");
  assert.equal(parsePlaceMutation({ ...validInput, currency: "sAr" }).currency, "SAR");
  // Trimming is the shared text rule every field already follows; it never
  // rescues a near-miss code, so nothing is stored that the CHECK would refuse.
  assert.equal(parsePlaceMutation({ ...validInput, currency: " IDR " }).currency, "IDR");
  assert.throws(() => parsePlaceMutation({ ...validInput, currency: " IDRX " }), /place_currency_invalid/);
});

// ---------------------------------------------------------------------------
// Deterministic, locale-independent rendering.
// ---------------------------------------------------------------------------

test("currency labels are fixed strings, identical in every runtime locale", () => {
  // Nothing here is derived from `Intl`, the host locale, or the timezone: a
  // Place's currency must read the same on every device forever, so the
  // rendering can never disagree with the stored code.
  const before = { ...process.env };
  try {
    for (const locale of ["id-ID", "en-US", "ar-SA", "de-DE", "C"]) {
      process.env.LANG = `${locale}.UTF-8`;
      process.env.LC_ALL = `${locale}.UTF-8`;
      process.env.TZ = "Asia/Jakarta";
      assert.equal(placeCurrencyLabel("IDR"), PLACE_CURRENCY_LABELS.IDR);
      assert.equal(placeCurrencyLabel("USD"), PLACE_CURRENCY_LABELS.USD);
      assert.equal(placeCurrencyLabel("SAR"), PLACE_CURRENCY_LABELS.SAR);
    }
  } finally {
    process.env = before;
  }
});

test("every stored currency has a label, and an unknown one renders as itself", () => {
  for (const currency of PLACE_CURRENCIES) {
    assert.ok(placeCurrencyLabel(currency).startsWith(currency), `${currency} is labelled with its own code`);
  }
  // Fail-safe: an unexpected stored value is shown verbatim rather than as an
  // invented name or an empty control.
  assert.equal(placeCurrencyLabel("XYZ"), "XYZ");
  assert.equal(placeCurrencyLabel(""), "");
});

// ---------------------------------------------------------------------------
// The Producer surfaces are wired to the rule (no hardcoded second list).
// ---------------------------------------------------------------------------

test("the Producer Place form offers the application currencies from the shared rule", () => {
  const form = readFileSync(new URL("../app/producer/places/PlaceForm.tsx", import.meta.url), "utf8");
  assert.match(form, /APPLICATION_CURRENCIES\.map\(/);
  assert.match(form, /PLACE_CURRENCY_LABELS\[currency\]/);
  // The two labels the form showed before are byte-identical: the shared rule
  // changed where they come from, never what the Producer sees.
  assert.equal(PLACE_CURRENCY_LABELS.IDR, "IDR — Rupiah Indonesia");
  assert.equal(PLACE_CURRENCY_LABELS.USD, "USD — Dolar Amerika Serikat");
  assert.equal(form.includes("<option value=\"SAR\""), false, "SAR is never offered to a Producer");
});

test("both Producer write routes enforce the application currency rule server-side", () => {
  for (const [name, source] of [
    ["create", producerCreateRoute],
    ["update", producerUpdateRoute],
  ] as const) {
    assert.match(source, /assertApplicationCurrency\(mutation\.currency\)/, `${name} enforces the rule`);
    assert.match(source, /PlaceInputError/, `${name} still maps the refusal to a 400`);
  }
});

test("the Admin currency select renders every stored currency from the shared list", () => {
  const editor = readFileSync(new URL("../components/admin/place-editor.tsx", import.meta.url), "utf8");
  assert.match(editor, /PLACE_CURRENCIES\.map\(/);
  // The label map is now the canonical one, so an Admin saving a SAR test Place
  // sees the same label the rest of the product uses.
  assert.match(editor, /const CURRENCY_LABEL: Record<string, string> = PLACE_CURRENCY_LABELS;/);
});
