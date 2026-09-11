export function getVisitIntentErrorMessage(status: number, errorCode: unknown): string {
  if (status === 401 || errorCode === "authentication_required") {
    return "Silakan login terlebih dahulu untuk mengirim Visit Intent.";
  }

  if (errorCode === "visit_intent_conflict") {
    return "Visit Intent dengan waktu yang sama sudah aktif.";
  }

  if (errorCode === "visit_intent_schedule_unavailable") {
    return "Jadwal Experience tidak tersedia pada tanggal atau waktu tersebut.";
  }

  if (errorCode === "visit_intent_time_invalid") {
    return "Pilih tanggal dan waktu kunjungan yang masih akan datang.";
  }

  if (errorCode === "visit_intent_party_size_invalid") {
    return "Jumlah peserta tidak sesuai dengan batas Experience.";
  }

  if (status === 400) {
    return "Data Visit Intent belum valid. Periksa kembali tanggal, waktu, dan jumlah peserta.";
  }

  return "Visit Intent belum dapat dikirim. Silakan coba lagi.";
}