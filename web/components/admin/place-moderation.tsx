"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { canAdminTransitionPlaceStatus } from "@/lib/places";
import { publicationStatusLabel } from "@/lib/status-labels";
import { type PublicationStatus } from "@/lib/places";

/**
 * Admin Place moderation controls: Terbitkan / Jeda / Arsipkan / Pulihkan dari
 * arsip.
 *
 * The available buttons are derived from the SAME transition rule the server
 * enforces (`canAdminTransitionPlaceStatus`) — this only avoids showing a
 * button that would be refused. The server remains the authority and
 * re-checks authorization, the transition, and publication readiness.
 *
 * There is deliberately no delete control: a Place is never hard-deleted as a
 * routine admin operation (Master 09 §8/§15).
 */
const ACTIONS: Array<{ status: PublicationStatus; label: string; className: string }> = [
  {
    status: "published",
    label: "Terbitkan",
    className: "bg-brand-primary text-white hover:bg-brand-primary-deep",
  },
  { status: "paused", label: "Jeda", className: "border border-black/15 text-black/70 hover:bg-black/[0.04]" },
  {
    status: "archived",
    label: "Arsipkan",
    className: "border border-red-200 text-red-800 hover:bg-red-50",
  },
  { status: "draft", label: "Pulihkan ke Draft", className: "border border-black/15 text-black/70 hover:bg-black/[0.04]" },
];

export default function AdminPlaceModeration({ placeId, status }: { placeId: string; status: PublicationStatus }) {
  const router = useRouter();
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<PublicationStatus | null>(null);

  async function apply(next: PublicationStatus) {
    setBusy(next);
    setFeedback("");
    try {
      const response = await fetch(`/api/admin/places/${placeId}/publication`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicationStatus: next }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error ?? "")
            : "";
        setFeedback(message || "Status tidak dapat diubah.");
        return;
      }
      setFeedback(`Status diubah ke ${publicationStatusLabel(next)}.`);
      router.refresh();
    } catch {
      setFeedback("Tidak dapat menghubungi server.");
    } finally {
      setBusy(null);
    }
  }

  const available = ACTIONS.filter((action) => canAdminTransitionPlaceStatus(status, action.status));

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {available.length === 0 ? (
          <p className="text-sm text-black/55">Tidak ada perubahan status yang tersedia dari status saat ini.</p>
        ) : (
          available.map((action) => (
            <button
              key={action.status}
              type="button"
              disabled={busy !== null}
              onClick={() => void apply(action.status)}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition disabled:opacity-50 ${action.className}`}
            >
              {busy === action.status ? "Memproses…" : action.label}
            </button>
          ))
        )}
      </div>
      {status === "archived" ? (
        <p className="text-xs leading-5 text-black/55">
          Arsip: Tempat tidak tampil sebagai tempat aktif atau publik, dan seluruh data (Kegiatan, Kunjungan, klaim,
          membership, Live, histori) tetap tersimpan. Pemulihan mengikuti aturan di atas dan akan memvalidasi ulang
          kelengkapan data.
        </p>
      ) : null}
      {feedback ? (
        <p className="rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 text-xs font-semibold text-black/70" role="status">
          {feedback}
        </p>
      ) : null}
    </div>
  );
}
