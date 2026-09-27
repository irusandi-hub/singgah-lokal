"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PLACE_CLAIM_EVIDENCE_ACCEPTED_TYPES,
  PLACE_CLAIM_EVIDENCE_MAX_BYTES,
  type ClaimablePlace,
  type PlaceClaimSummary,
  placeClaimErrorMessage,
} from "@/lib/place-claim";

/**
 * KLAIM PLACE YANG SUDAH ADA — the Producer claim surface.
 *
 * The flow the PO locked: list → pick an existing Place → see its canonical
 * data → upload proof of ownership → submit → the claim sits at "pending"
 * until an Admin reviews it.
 *
 * What this component deliberately does NOT do:
 * - it never creates or edits a Place, and there is no category/type input —
 *   the chosen Place's own canonical category and type are shown read-only;
 * - it never implies ownership. Submitting only files a claim; the copy says
 *   so, and the status list reflects what the server actually reports.
 *
 * The unowned-only filter is NOT implemented here: the list comes from the
 * server, which already excludes every Place that has an owner.
 */
type Feedback = { kind: "ok" | "error"; message: string } | null;

const STATUS_TONE: Record<PlaceClaimSummary["status"], string> = {
  pending: "bg-amber-500",
  approved: "bg-green-600",
  rejected: "bg-red-800",
};

const STATUS_LABEL: Record<PlaceClaimSummary["status"], string> = {
  pending: "Menunggu penilaian Admin",
  approved: "Disetujui — ownership diberikan",
  rejected: "Ditolak",
};

export default function PlaceClaimPanel({ onBack }: { onBack: () => void }) {
  const [places, setPlaces] = useState<ClaimablePlace[] | null>(null);
  const [placesFailed, setPlacesFailed] = useState(false);
  const [claims, setClaims] = useState<PlaceClaimSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [placesResponse, claimsResponse] = await Promise.all([
        fetch("/api/producer/place-claims/claimable-places"),
        fetch("/api/producer/place-claims"),
      ]);
      if (placesResponse.ok) {
        const payload: unknown = await placesResponse.json().catch(() => null);
        const list =
          payload && typeof payload === "object" && "places" in payload
            ? (payload as { places: ClaimablePlace[] }).places
            : null;
        if (Array.isArray(list)) {
          setPlaces(list);
          setPlacesFailed(false);
        } else {
          setPlacesFailed(true);
        }
      } else {
        setPlacesFailed(true);
      }
      if (claimsResponse.ok) {
        const payload: unknown = await claimsResponse.json().catch(() => null);
        const list =
          payload && typeof payload === "object" && "claims" in payload
            ? (payload as { claims: PlaceClaimSummary[] }).claims
            : null;
        if (Array.isArray(list)) setClaims(list);
      }
    } catch {
      setPlacesFailed(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const selected = places?.find((place) => place.id === selectedId) ?? null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (!selectedId) {
      setFeedback({ kind: "error", message: "Pilih Tempat yang ingin diklaim." });
      return;
    }
    if (!file) {
      // Mirrors the server rule: a claim without proof is refused.
      setFeedback({ kind: "error", message: placeClaimErrorMessage("place_claim_evidence_required") });
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("placeId", selectedId);
      form.set("file", file);
      form.set("note", note);
      const response = await fetch("/api/producer/place-claims", { method: "POST", body: form });
      const payload: unknown = await response.json().catch(() => null);
      const code =
        payload && typeof payload === "object" && "code" in payload
          ? String((payload as { code?: unknown }).code ?? "")
          : "";
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: code
            ? placeClaimErrorMessage(code)
            : "Klaim gagal dikirim. Coba lagi.",
        });
        return;
      }
      setSelectedId("");
      setFile(null);
      setNote("");
      setFeedback({
        kind: "ok",
        message:
          "Klaim terkirim dan berstatus menunggu penilaian. Ownership diberikan hanya setelah Admin menyetujui.",
      });
      await load();
    } catch {
      setFeedback({ kind: "error", message: "Tidak dapat menghubungi server." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Klaim Tempat yang Sudah Ada" className="mt-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">
            Klaim Tempat yang Sudah Ada
          </h2>
          <p className="mt-1 text-xs text-black/55">
            Hanya Tempat tanpa pemilik yang dapat diklaim. Tempat tidak dibuat atau diubah oleh klaim.
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg border border-black/15 px-4 py-2 text-sm font-bold"
        >
          Kembali ke daftar
        </button>
      </div>

      {claims.length > 0 && (
        <div className="mb-5 rounded-2xl border border-black/10 bg-white p-4">
          <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-black/45">Status klaim kamu</h3>
          <ul className="mt-2 divide-y divide-black/5">
            {claims.map((claim) => (
              <li key={claim.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{claim.placeName}</span>
                  <span className="text-xs text-black/50">
                    {claim.category} · {claim.type} · diajukan {new Date(claim.createdAt).toLocaleDateString("id-ID")}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-xs font-bold">
                  <span className={`inline-block h-2 w-2 rounded-full ${STATUS_TONE[claim.status]}`} aria-hidden />
                  {STATUS_LABEL[claim.status]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {placesFailed ? (
        <p className="rounded-2xl border border-red-800/20 bg-white p-4 text-sm font-semibold text-red-800" role="alert">
          Daftar Tempat tidak dapat dimuat. Coba muat ulang halaman.
        </p>
      ) : places === null ? (
        <p className="text-sm text-black/60" role="status">
          Memuat…
        </p>
      ) : places.length === 0 ? (
        <p className="text-sm text-black/60" role="status">
          Tidak ada Tempat tanpa pemilik saat ini. Tempat yang sudah dimiliki Pengelola tidak dapat diklaim.
        </p>
      ) : (
        <form onSubmit={submit} className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
          <label htmlFor="claim-place" className="block text-sm font-bold">
            Tempat yang diklaim
          </label>
          <select
            id="claim-place"
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
            className="mt-2 w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm"
          >
            <option value="">Pilih Tempat…</option>
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name} — {place.area}
              </option>
            ))}
          </select>

          {selected && (
            <div className="mt-4 rounded-xl border border-black/10 bg-brand-cream/40 p-4">
              <p className="text-sm font-bold">{selected.name}</p>
              <p className="mt-1 text-xs leading-5 text-black/60">{selected.shortDescription}</p>
              <p className="mt-2 text-xs text-black/60">
                Kategori: <strong>{selected.category}</strong> · Tipe: <strong>{selected.type}</strong> · Area:{" "}
                <strong>{selected.area}</strong>
              </p>
              <p className="mt-2 text-xs text-black/50">
                Kategori dan tipe mengikuti Tempat yang ada dan tidak dapat diubah melalui klaim.
              </p>
            </div>
          )}

          <label htmlFor="claim-evidence" className="mt-4 block text-sm font-bold">
            Bukti kepemilikan <span className="font-normal text-black/55">(wajib)</span>
          </label>
          <input
            id="claim-evidence"
            type="file"
            required
            accept={PLACE_CLAIM_EVIDENCE_ACCEPTED_TYPES.join(",")}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="mt-2 block w-full text-sm"
          />
          <p className="mt-1 text-xs text-black/50">
            Maksimal {Math.round(PLACE_CLAIM_EVIDENCE_MAX_BYTES / (1024 * 1024))} MB, format{" "}
            {PLACE_CLAIM_EVIDENCE_ACCEPTED_TYPES.map((type) => type.split("/")[1].toUpperCase()).join(", ")}.
            Bukti disimpan secara privat dan hanya dapat dinilai Admin.
          </p>

          <label htmlFor="claim-note" className="mt-4 block text-sm font-bold">
            Catatan <span className="font-normal text-black/55">(opsional)</span>
          </label>
          <textarea
            id="claim-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            maxLength={1000}
            className="mt-2 w-full rounded-xl border border-black/10 px-3 py-2 text-sm"
          />

          <button
            type="submit"
            disabled={busy}
            className="mt-4 rounded-xl bg-brand-primary px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-primary-deep disabled:opacity-50"
          >
            {busy ? "Mengirim…" : "Kirim klaim"}
          </button>
        </form>
      )}

      {feedback ? (
        <p
          className={`mt-3 rounded-xl border px-3 py-2 text-xs font-semibold ${
            feedback.kind === "ok"
              ? "border-brand-primary/30 bg-brand-primary/10 text-brand-primary"
              : "border-red-800/30 bg-red-800/10 text-red-800"
          }`}
          role="status"
        >
          {feedback.message}
        </p>
      ) : null}
    </section>
  );
}
