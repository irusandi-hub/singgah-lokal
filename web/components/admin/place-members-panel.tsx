"use client";

import { useState } from "react";
import Link from "next/link";
import { formatAdminTimestamp, formatShortId } from "@/components/admin/ui";
import ProducerAccessRevokeDialog, {
  type ProducerAccessRevokeFeedback,
  type ProducerAccessRevokeTarget,
} from "@/components/admin/producer-access-revoke-dialog";
import { producerRoleLabel } from "@/lib/producer";

/**
 * ADMIN PLACE DETAIL — the "Pengelola" section of ONE Place.
 *
 * Management access to a Place IS the membership list (`producer_memberships`),
 * so this section is the surface where an admin can revoke ONE account's access
 * to THIS Place — through the same shared dialog/request as the Data Pengelola
 * list (components/admin/producer-access-revoke-dialog.tsx), never a second
 * implementation. The action label here is "Cabut Hak Pengelolaan"; the Data
 * Pengelola list keeps "Cabut Hak Akses".
 *
 * PERMANENT POLICY (migration 0058). Every membership is revocable, INCLUDING
 * the last owner: a Place is allowed to exist without an active digital
 * manager and the admin is never forced to appoint a replacement. When the list
 * is empty the section says so explicitly and offers the established recovery
 * path (the official Place-claim process) instead of a forced assignment. The
 * Place's publication state is shown alongside, so an archived Place reads as
 * archived rather than as an error.
 */

/** Structural shape of the membership the server passes in (serializable). */
type PlaceMembership = {
  membershipId: string;
  userId: string;
  producerId: string;
  role: string;
  createdAt: string;
  userEmail: string | null;
};

const ARCHIVED_HINT =
  "Tempat ini diarsipkan: tidak tampil di Discovery dan tidak dapat dikunjungi sampai dipulihkan dari arsip.";

export default function AdminPlaceMembersPanel({
  placeName,
  memberships,
  publicationStatus,
}: {
  placeName: string;
  memberships: PlaceMembership[];
  /** Canonical publication status of THIS Place (draft/published/paused/archived). */
  publicationStatus?: string | null;
}) {
  const [revokeTarget, setRevokeTarget] = useState<ProducerAccessRevokeTarget | null>(null);
  const [feedback, setFeedback] = useState<ProducerAccessRevokeFeedback>(null);

  const archived = publicationStatus === "archived";

  return (
    <div className="grid gap-3">
      {feedback ? (
        <p
          role={feedback.kind === "error" ? "alert" : "status"}
          className={`rounded-xl border px-3.5 py-2.5 text-sm font-semibold ${
            feedback.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : feedback.kind === "warn"
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {feedback.message}
        </p>
      ) : null}

      {archived ? (
        <p
          data-testid="place-archived-notice"
          className="rounded-xl border border-black/10 bg-black/5 px-3.5 py-2.5 text-xs font-semibold text-black/70"
        >
          {ARCHIVED_HINT}
        </p>
      ) : null}

      {memberships.length === 0 ? (
        <div data-testid="place-managerless-notice" className="rounded-xl border border-black/10 bg-black/5 p-3.5">
          <p className="text-sm font-semibold text-black/75">Tanpa Pengelola digital aktif.</p>
          <p className="mt-1 text-xs leading-5 text-black/60">
            Tempat ini tetap tersimpan beserta data dan riwayat administrasinya. Keadaan tanpa
            Pengelola adalah keadaan yang sah; tidak ada pengelola pengganti yang wajib ditunjuk.
            Pemberian kewenangan pengelolaan berikutnya hanya lewat proses resmi —{" "}
            <Link href="/admin/places" className="font-bold text-brand-primary underline underline-offset-2">
              persetujuan klaim Tempat
            </Link>
            .
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-black/5">
          {memberships.map((membership) => {
            const account = membership.userEmail ?? formatShortId(membership.userId);
            return (
              <li
                key={membership.membershipId}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-black/80" data-testid="place-member-account">
                    {account}
                  </p>
                  <p className="text-xs text-black/55">
                    {producerRoleLabel(membership.role)} · {membership.producerId} ·{" "}
                    {formatAdminTimestamp(membership.createdAt)}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={`Cabut hak pengelolaan ${account} atas ${placeName}`}
                  onClick={() => {
                    setFeedback(null);
                    setRevokeTarget({
                      membershipId: membership.membershipId,
                      producerName: account,
                      email: membership.userEmail,
                      placeName,
                      role: membership.role,
                    });
                  }}
                  className="inline-block max-w-full whitespace-normal rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-bold leading-tight text-red-800 transition hover:bg-red-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-red-400"
                >
                  Cabut Hak Pengelolaan
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <ProducerAccessRevokeDialog
        revokeTarget={revokeTarget}
        actionLabel="Cabut Hak Pengelolaan"
        dialogTitle="Cabut Hak Pengelolaan?"
        warning={`Akun ini akan kehilangan hak mengelola Tempat ${placeName}. Akun tersebut dan pengelola lain Tempat ini akan diberi tahu lewat notifikasi.`}
        onClose={() => setRevokeTarget(null)}
        onFeedback={setFeedback}
      />
    </div>
  );
}
