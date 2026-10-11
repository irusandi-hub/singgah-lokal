import Link from "next/link";
import type { AccountVerificationSummary } from "@/lib/account/profile";
import {
  accountProfileDisplayName,
  accountProfileInitials,
  verificationStatusLabel,
  verificationStatusTone,
} from "@/lib/account/profile-view";
import { StatusBadge, btn, metaTextClass } from "@/components/ui/kit";

/**
 * PROFIL SAYA — the identity SUMMARY panel of the Account & Access Center.
 *
 * Read-only on purpose (task decision, Tahap 3): this panel shows the photo or
 * initials, the name, the username and the VERIFICATION SUMMARY, and its only
 * action is "Edit Profil", a link to the separate /account/profile screen. There
 * is no editable field here, so the main account page can never save a
 * half-filled form or show an input that is not backed by a real profile column.
 *
 * Every value comes from the server (see lib/account/profile-read.ts): the
 * initials are a FALLBACK for a missing photo, never a fabricated image, and a
 * verification status is derived ONLY from the two stored facts the server
 * returns — email from Supabase Auth and phone from `phone_verified_at`.
 *
 * Verification stays SEPARATE: this panel reports account contact facts only. It
 * never implies a verified manager or a verified Place, and it renders no badge
 * for either.
 */

type Props = {
  fullName: string | null;
  username: string | null;
  email: string | null;
  avatarUrl: string | null;
  verification: AccountVerificationSummary;
};

function VerificationRow({
  label,
  value,
  status,
}: {
  label: string;
  value: string | null;
  status: { verified: boolean };
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-1.5">
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-black/70">{label}</span>
        <span className={`block break-words text-black/55 ${metaTextClass}`}>
          {value?.trim() ? value : "Belum ada"}
        </span>
      </span>
      <StatusBadge tone={verificationStatusTone(value, status.verified)}>
        {verificationStatusLabel(value, status.verified)}
      </StatusBadge>
    </div>
  );
}

export default function AccountProfileClient({
  fullName,
  username,
  email,
  avatarUrl,
  verification,
}: Props) {
  const displayName = accountProfileDisplayName({ fullName, username, email });
  const initials = accountProfileInitials({ fullName, username, email });

  return (
    <div className="grid gap-3.5">
      <div className="flex items-center gap-3.5">
        {avatarUrl ? (
          /* Signed, short-lived URL for this account's own avatar. A plain
             <img> is used because the URL is a private-bucket signed URL whose
             host is not (and must not be) statically allowlisted for
             next/image. Same rationale and pattern as the Place hero. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt="Foto profil"
            className="h-12 w-12 shrink-0 rounded-full border border-black/10 object-cover"
          />
        ) : (
          <span
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand-accent text-base font-bold text-white"
            aria-hidden
          >
            {initials}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-bold text-brand-ink">
            {displayName}
          </span>
          {username?.trim() ? (
            <span className={`mt-0.5 block break-words text-black/55 ${metaTextClass}`}>
              @{username.trim()}
            </span>
          ) : null}
        </span>
      </div>

      <div className="grid gap-2.5 border-t border-black/10 pt-3.5">
        <VerificationRow label="Email" value={email} status={verification.email} />
        <VerificationRow
          label="Nomor telepon"
          value={verification.phone.value}
          status={verification.phone}
        />
      </div>

      <Link href="/account/profile" className={`${btn.secondary} w-full`}>
        Edit Profil
      </Link>
    </div>
  );
}
