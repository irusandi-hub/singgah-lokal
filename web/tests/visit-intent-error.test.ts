import assert from "node:assert/strict";
import test from "node:test";
import { getVisitIntentErrorMessage } from "../lib/visit-intent-error";

test("maps authentication failure to a login message", () => {
  assert.equal(
    getVisitIntentErrorMessage(401, "authentication_required"),
    "Silakan login terlebih dahulu untuk mengirim Visit Intent.",
  );
});

test("maps Visit Intent validation errors to safe UX messages", () => {
  assert.equal(getVisitIntentErrorMessage(400, "visit_intent_schedule_unavailable"), "Jadwal Experience tidak tersedia pada tanggal atau waktu tersebut.");
  assert.equal(getVisitIntentErrorMessage(400, "visit_intent_time_invalid"), "Pilih tanggal dan waktu kunjungan yang masih akan datang.");
  assert.equal(getVisitIntentErrorMessage(400, "visit_intent_party_size_invalid"), "Jumlah peserta tidak sesuai dengan batas Experience.");
  assert.equal(getVisitIntentErrorMessage(409, "visit_intent_conflict"), "Visit Intent dengan waktu yang sama sudah aktif.");
});

test("does not expose unknown API or internal errors", () => {
  const message = getVisitIntentErrorMessage(500, "database connection failed");

  assert.equal(message, "Visit Intent belum dapat dikirim. Silakan coba lagi.");
  assert.equal(message.includes("database"), false);
});