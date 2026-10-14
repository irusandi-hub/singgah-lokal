"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { producerRoleLabel } from "@/lib/producer";

/**
 * ADMIN-REVOKE — the ONE confirmation dialog + request that removes a
 * Pengelola's management access to ONE Place.
 *
 * Extracted (2026-10-14) from `AdminPengelolaTable` so the SAME behaviour backs
 * both Admin surfaces — the Data Pengelola list and the Place-detail
 * "Pengelola" section — instead of a copy. It is a MIRROR only:
 * - authorization, the last-owner safeguard, the audit trail, and the
 *   notifications all happen server-side in one transaction
 *   (POST /api/admin/producer-memberships/:membershipId/revoke);
 * - it sends ONLY the membership id; the account and Tempat are resolved from
 *   the database row, never from the client;
 * - it never fires before the explicit confirmation rendered here;
 * - it locks its own buttons while working and always reports the SERVER's own
 *   message (success is only ever reported when the server confirms it);
 * - it refreshes the server data afterwards, so no client state is a source of
 *   truth.
 *
 * Only ONE dialog can be open at a time on either surface, so the ARIA ids are
 * fixed (not generated) and stay stable for assistive tech.
 */

/** What the revoke action needs to name the account and the Place. */
export type ProducerAccessRevokeTarget = {
  membershipId: string;
  /** Display name of the Pengelola/account being revoked. */
  producerName: string;
  email: string | null;
  placeName: string | null;
  /** Membership role (owner/manager/editor). */
  role: string;
};

export type ProducerAccessRevokeFeedback =
  | { kind: "ok" | "warn" | "error"; message: string }
  | null;

type Props = {
  /** The row to revoke; `null` renders nothing (dialog closed). */
  revokeTarget: ProducerAccessRevokeTarget | null;
  /** Confirm button text, per surface label convention. */
  actionLabel: string;
  /** Dialog heading, per surface label convention. */
  dialogTitle: string;
  /** The "what this person loses" sentence (surface-owned copy). */
  warning: string;
  /** Closes the dialog without any request (Batal). */
  onClose: () => void;
  /** Reports the surface-level outcome banner. */
  onFeedback: (feedback: ProducerAccessRevokeFeedback) => void;
};

export default function ProducerAccessRevokeDialog({
  revokeTarget,
  actionLabel,
  dialogTitle,
  warning,
  onClose,
  onFeedback,
}: Props) {
  const router = useRouter();
  const [working, setWorking] = useState(false);

  if (!revokeTarget) return null;
  const target = revokeTarget;

  async function confirmRevoke() {
    if (working) return;
    setWorking(true);
    try {
      const response = await fetch(
        `/api/admin/producer-memberships/${encodeURIComponent(target.membershipId)}/revoke`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
        error?: string;
        notified?: boolean;
      };

      if (response.ok) {
        onClose();
        // The server already told us whether the notification went out; a
        // failed notification must be surfaced, never hidden behind "sukses".
        onFeedback(
          payload.notified === false
            ? { kind: "warn", message: "Hak akses dicabut, tetapi notifikasi gagal dikirim." }
            : { kind: "ok", message: "Hak akses dicabut. Notifikasi sudah dikirim." },
        );
        router.refresh();
        return;
      }

      // Refusals (owner terakhir, id tidak ditemukan, sudah dicabut): the
      // server's own Indonesian message is what the operator sees.
      onClose();
      onFeedback({
        kind: "error",
        message: payload.message ?? payload.error ?? "Hak akses gagal dicabut.",
      });
      // A state that changed outside this click (already revoked) needs a fresh
      // read so the surface never shows a stale relation.
      if (payload.status === "already_revoked") router.refresh();
    } catch {
      onClose();
      onFeedback({ kind: "error", message: "Hak akses gagal dicabut. Coba lagi." });
    } finally {
      setWorking(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="revoke-producer-access-title"
      aria-describedby="revoke-producer-access-warning"
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 p-4"
    >
      <div className="w-full max-w-sm rounded-2xl border border-black/10 bg-white p-4">
        <h4 id="revoke-producer-access-title" className="text-sm font-bold">
          {dialogTitle}
        </h4>
        <dl className="mt-2 grid gap-1.5 text-xs leading-5">
          <div>
            <dt className="font-bold uppercase tracking-[0.1em] text-black/45">Pengelola</dt>
            <dd className="font-semibold" data-testid="revoke-dialog-producer">
              {revokeTarget.producerName}
            </dd>
          </div>
          <div>
            <dt className="font-bold uppercase tracking-[0.1em] text-black/45">Email</dt>
            <dd data-testid="revoke-dialog-email">{revokeTarget.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="font-bold uppercase tracking-[0.1em] text-black/45">Tempat</dt>
            <dd className="font-semibold" data-testid="revoke-dialog-place">
              {revokeTarget.placeName ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="font-bold uppercase tracking-[0.1em] text-black/45">Status akses</dt>
            <dd>{producerRoleLabel(revokeTarget.role)}</dd>
          </div>
        </dl>
        <p id="revoke-producer-access-warning" className="mt-2.5 text-xs leading-5 text-black/60">
          {warning}
        </p>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={working}
            className="rounded-full border border-black/15 bg-white px-3 py-1.5 text-xs font-bold text-black/70 disabled:opacity-60"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={() => void confirmRevoke()}
            disabled={working}
            className="rounded-full bg-red-700 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
          >
            {working ? "Mencabut…" : actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
