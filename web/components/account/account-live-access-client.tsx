"use client";

import type { AccountLiveOperatorAssignment } from "@/lib/account-live-operators";

type Props = {
  assignments: AccountLiveOperatorAssignment[];
};

/**
 * Operator Live — delegated Live access ONLY.
 *
 * Each card is a real public.live_operators assignment for the signed-in
 * account. Producer owner/manager membership never produces a card here: it is
 * shown separately as Pengelola.
 */
export default function AccountLiveAccessClient({ assignments }: Props) {
  if (assignments.length === 0) return null;

  return (
    <div className="grid gap-2">
      {assignments.map(({ placeId, placeName }) => (
        <a
          key={placeId}
          href={`/producer/live?place=${encodeURIComponent(placeId)}`}
          className="flex w-full items-center gap-3 rounded-xl border border-brand-accent/20 bg-brand-accent/5 px-3 py-2.5 text-left transition hover:bg-brand-accent/10"
        >
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-semibold text-brand-ink">
              Operator Live — {placeName}
            </span>
            <span className="mt-0.5 block text-xs text-black/55">
              Operasi Live hanya untuk Tempat ini.
            </span>
          </span>
        </a>
      ))}
    </div>
  );
}
