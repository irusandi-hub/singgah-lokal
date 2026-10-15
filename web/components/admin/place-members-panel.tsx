"use client";

import { useState } from "react";
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
 * A membership that cannot be revoked — the LAST owner, which the server also
 * refuses fail-closed to avoid leaving the Place without an owner — is shown
 * DISABLED with a short reason, not hidden.
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

export default function AdminPlaceMembersPanel({
  placeName,
  memberships,
}: {
  placeName: string;
  memberships: PlaceMembership[];
}) {
  const [revokeTarget, setRevokeTarget] = useState<ProducerAccessRevokeTarget | null>(null);
  const [feedback, setFeedback] = useState<ProducerAccessRevokeFeedback>(null);

  if (memberships.length === 0) {
    return <p className="text-xs text-black/50">Belum ada membership.</p>;
  }

  // The last owner cannot be revoked (server-enforced); compute it here only to
  // explain the disabled action, never to decide authorization.
  const ownerCount = memberships.filter((membership) => membership.role === "owner").length;

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

      <ul className="divide-y divide-black/5">
        {memberships.map((membership) => {
          const lastOwner = membership.role === "owner" && ownerCount <= 1;
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
              {lastOwner ? (
                <span className="text-[11px] font-semibold text-black/45" data-testid="place-member-locked">
                  Tidak dapat dicabut: Pemilik terakhir.
                </span>
              ) : (
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
              )}
            </li>
          );
        })}
      </ul>

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
