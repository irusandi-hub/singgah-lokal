"use client";

import type { AccountLiveOperatorAssignment } from "@/lib/account-live-operators";
import { ListRow } from "@/components/ui/kit";
import { OperatorLiveIcon } from "./account-icons";

type Props = {
  assignments: AccountLiveOperatorAssignment[];
};

/**
 * Operator Live — delegated Live access ONLY.
 *
 * Each row is a real public.live_operators assignment for the signed-in
 * account and shows the exact canonical Place name. Producer owner/manager
 * membership never produces a row here: it is shown separately as Pengelola.
 */
export default function AccountLiveAccessClient({ assignments }: Props) {
  if (assignments.length === 0) return null;

  return (
    <div className="grid gap-2">
      {assignments.map(({ placeId, placeName }) => (
        <ListRow
          key={placeId}
          href={`/producer/live?place=${encodeURIComponent(placeId)}`}
          leading={<OperatorLiveIcon />}
          title={<>Operator Live — {placeName}</>}
          meta="Operasi Live hanya untuk Tempat ini."
        />
      ))}
    </div>
  );
}
