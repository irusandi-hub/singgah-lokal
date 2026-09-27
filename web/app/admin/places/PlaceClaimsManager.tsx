"use client";

import { useCallback, useEffect, useState } from "react";
import { placeClaimErrorMessage } from "@/lib/place-claim";

/**
 * Admin review of Place claims (Platform Moderator only — the API enforces
 * it; this panel is just the surface, same as the Producer applications
 * manager on the Producer Membership page).
 *
 * Each row carries what the Admin needs to assess the claim: the claimed
 * Place, its CANONICAL category/type, the claimant, the submission time, the
 * status, and the proof of ownership. Evidence is fetched from a private
 * bucket through a short-lived signed link minted server-side for moderators
 * only — there is no public document URL.
 *
 * Approving is the only action that grants ownership, and it happens once:
 * the server refuses a second decision on a non-pending claim. Nothing is
 * approved automatically.
 */
type ReviewClaim = {
  id: string;
  placeId: string;
  placeName: string;
  category: string;
  type: string;
  userId: string;
  status: "pending" | "approved" | "rejected";
  evidenceFileName: string | null;
  note: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
};

type Feedback = { kind: "ok" | "error"; message: string } | null;

const TONE: Record<ReviewClaim["status"], "positive" | "warning" | "negative"> = {
  pending: "warning",
  approved: "positive",
  rejected: "negative",
};

export default function PlaceClaimsManager() {
  const [claims, setClaims] = useState<ReviewClaim[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchClaims = useCallback(async (): Promise<ReviewClaim[] | null> => {
    try {
      const response = await fetch("/api/admin/place-claims");
      if (!response.ok) return null;
      const payload: unknown = await response.json().catch(() => null);
      if (!payload || typeof payload !== "object" || !("claims" in payload)) return null;
      return (payload as { claims: ReviewClaim[] }).claims ?? [];
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await fetchClaims();
      if (cancelled) return;
      if (rows === null) {
        setLoadFailed(true);
      } else {
        setClaims(rows);
        setLoadFailed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchClaims]);

  async function review(claimId: string, decision: "approved" | "rejected") {
    setBusyId(claimId);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/place-claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimId, decision }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code =
          payload && typeof payload === "object" && "code" in payload
            ? String((payload as { code?: unknown }).code ?? "")
            : "";
        setFeedback({ kind: "error", message: code ? placeClaimErrorMessage(code) : "Review gagal." });
        return;
      }
      const rows = await fetchClaims();
      setClaims(rows ?? []);
      setFeedback({
        kind: "ok",
        message:
          decision === "approved"
            ? "Klaim disetujui. Ownership Tempat diberikan ke akun pengaju."
            : "Klaim ditolak. Tempat tetap tanpa pemilik.",
      });
    } catch {
      setFeedback({ kind: "error", message: "Tidak dapat menghubungi server." });
    } finally {
      setBusyId(null);
    }
  }

  async function openEvidence(claimId: string) {
    setFeedback(null);
    try {
      const response = await fetch(`/api/admin/place-claims/${claimId}/evidence`);
      const payload: unknown = await response.json().catch(() => null);
      const url =
        payload && typeof payload === "object" && "url" in payload
          ? String((payload as { url?: unknown }).url ?? "")
          : "";
      if (!response.ok || !url) {
        setFeedback({ kind: "error", message: "Bukti tidak dapat dibuka." });
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setFeedback({ kind: "error", message: "Tidak dapat menghubungi server." });
    }
  }

  if (loadFailed) {
    return (
      <section className="rounded-2xl border border-black/10 bg-white p-5">
        <p className="text-sm font-semibold text-red-800" role="alert">
          Daftar klaim tidak dapat dimuat. Periksa bahwa migration 0028 sudah diterapkan.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Klaim Tempat" className="rounded-2xl border border-black/10 bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-black/50">Klaim Tempat</h2>
      <p className="mt-1 text-xs leading-5 text-black/55">
        Persetujuan adalah satu-satunya jalan memberikan ownership. Tempat tetap tanpa pemilik selama klaim
        pending maupun setelah ditolak. Bukti kepemilikan bersifat privat dan hanya dibuka untuk Platform
        Moderator.
      </p>

      {claims === null ? (
        <p className="mt-4 text-sm font-semibold text-black/60" role="status">
          Memuat…
        </p>
      ) : claims.length === 0 ? (
        <p className="mt-4 text-sm text-black/60" role="status">
          Belum ada klaim Tempat.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-black/5">
          {claims.map((claim) => (
            <li key={claim.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-black/80">{claim.placeName}</p>
                  <p className="mt-0.5 text-xs text-black/55">
                    {claim.category} · {claim.type} · <span className="font-mono">{claim.placeId}</span>
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-black/50">
                    pengaju {claim.userId.slice(0, 8)}… · {new Date(claim.createdAt).toLocaleString("id-ID")}
                  </p>
                  {claim.note ? <p className="mt-1 text-xs italic text-black/60">“{claim.note}”</p> : null}
                  <p className="mt-1 text-xs text-black/50">
                    bukti: {claim.evidenceFileName ?? "—"}
                    {claim.status === "pending" ? (
                      <button
                        type="button"
                        onClick={() => void openEvidence(claim.id)}
                        className="ml-2 font-bold text-brand-primary underline underline-offset-2"
                      >
                        lihat bukti
                      </button>
                    ) : null}
                  </p>
                  {claim.reviewNote ? (
                    <p className="mt-1 text-xs text-black/60">catatan review: {claim.reviewNote}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-1 text-[11px] font-bold ${
                      TONE[claim.status] === "positive"
                        ? "bg-green-600/10 text-green-700"
                        : TONE[claim.status] === "negative"
                          ? "bg-red-800/10 text-red-800"
                          : "bg-amber-500/15 text-amber-700"
                    }`}
                  >
                    {claim.status}
                  </span>
                  {claim.status === "pending" ? (
                    <>
                      <button
                        type="button"
                        disabled={busyId === claim.id}
                        onClick={() => void review(claim.id, "approved")}
                        className="rounded-xl bg-brand-primary px-3 py-2 text-xs font-bold text-white transition hover:bg-brand-primary-deep disabled:opacity-50"
                      >
                        Setujui
                      </button>
                      <button
                        type="button"
                        disabled={busyId === claim.id}
                        onClick={() => void review(claim.id, "rejected")}
                        className="rounded-xl border border-black/15 px-3 py-2 text-xs font-bold transition hover:bg-black/[0.04] disabled:opacity-50"
                      >
                        Tolak
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
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
