"use client";

import type { AccountPlaceMembership } from "@/lib/account-memberships";

type Props = {
  memberships: AccountPlaceMembership[];
};

export default function AccountLiveAccessClient({ memberships }: Props) {
  if (memberships.length === 0) return null;

  return (
    <div className="grid gap-2">
      {memberships.map(({ placeId }) => (
        <a
          key={placeId}
          href={`/producer/live?place=${placeId}`}
          className="flex w-full items-center gap-3 rounded-xl border border-brand-accent/20 bg-brand-accent/5 px-3 py-2.5 text-left transition hover:bg-brand-accent/10"
        >
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-semibold text-brand-ink">
              Operator Live — {placeId}
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
