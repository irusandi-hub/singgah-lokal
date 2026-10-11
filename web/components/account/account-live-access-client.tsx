"use client";

import type { AccountLiveOperatorAssignment } from "@/lib/account-live-operators";
import { ListRow } from "@/components/ui/kit";
import { OperatorLiveIcon } from "./account-icons";

type Props = {
  assignments: AccountLiveOperatorAssignment[];
};

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Operator Live — delegated Live access ONLY.
 *
 * Each row is a real public.live_operators assignment for the signed-in account
 * and shows the exact canonical Place name. Producer owner/manager membership
 * never produces a row here: it is shown separately as Pengelola.
 *
 * Tahap 3 (mobile): the row meta is the PER-ROW fact (when the access was
 * granted). The identical sentence that used to repeat under every Place is
 * gone — a description that says the same thing on every row is noise, and the
 * row's meaning is already carried by its label and the account page's
 * "Operator Live" heading.
 */
export default function AccountLiveAccessClient({ assignments }: Props) {
  if (assignments.length === 0) return null;

  return (
    <div className="grid gap-2">
      {assignments.map(({ placeId, placeName, grantedAt }) => (
        <ListRow
          key={placeId}
          href={`/producer/live?place=${encodeURIComponent(placeId)}`}
          leading={<OperatorLiveIcon />}
          title={<>Operator Live — {placeName}</>}
          meta={`Diberikan ${formatWhen(grantedAt)}`}
        />
      ))}
    </div>
  );
}
