"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Admin Tempat Pilihan controls (Stage 4): "Jadikan Tempat Pilihan" /
 * "Cabut Promosi".
 *
 * A LAYER decision only — separate from Discovery by design. The component
 * cannot and does not send any score, star, eligibility, publication, claim,
 * or ownership value: the payload is exactly one boolean. The server remains
 * the authority (route + workspace both re-verify moderator authorization,
 * write the flag through the service role, and record the audit with
 * rollback on failure).
 */
export default function AdminPlaceCuration({
  placeId,
  isCurated,
}: {
  placeId: string;
  isCurated: boolean;
}) {
  const router = useRouter();
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);

  async function apply(next: boolean) {
    setBusy(true);
    setFeedback("");
    try {
      const response = await fetch(`/api/admin/places/${placeId}/curated`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isCurated: next }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error ?? "")
            : "";
        setFeedback(message || "Keputusan tidak dapat disimpan.");
        return;
      }
      setFeedback(next ? "Place kini menjadi Tempat Pilihan." : "Promosi Tempat Pilihan dicabut.");
      router.refresh();
    } catch {
      setFeedback("Tidak dapat menghubungi server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-black/70">
          {isCurated ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-ink px-3 py-1 text-xs font-bold text-white">
              ✦ Tempat Pilihan
            </span>
          ) : (
            <span className="text-black/55">Bukan Tempat Pilihan</span>
          )}
        </span>
        {isCurated ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => apply(false)}
            className="inline-flex items-center rounded-full border border-black/15 px-4 py-2 text-xs font-bold text-black/70 transition hover:bg-black/[0.04] disabled:opacity-50"
          >
            {busy ? "Menyimpan…" : "Cabut Promosi"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => apply(true)}
            className="inline-flex items-center rounded-full bg-brand-primary px-4 py-2 text-xs font-bold text-white transition hover:bg-brand-primary-deep disabled:opacity-50"
          >
            {busy ? "Menyimpan…" : "Jadikan Tempat Pilihan"}
          </button>
        )}
      </div>
      <p className="text-xs text-black/45">
        Tempat Pilihan adalah promosi Admin pada layer Home — terpisah dari Discovery, yang selalu
        dihitung sistem dari data kanonik.
      </p>
      {feedback && <p className="text-xs font-semibold text-black/70">{feedback}</p>}
    </div>
  );
}
