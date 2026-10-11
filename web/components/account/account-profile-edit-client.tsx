"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import type { AccountVerificationSummary } from "@/lib/account/profile";
import {
  accountProfileDisplayName,
  accountProfileInitials,
  verificationStatusLabel,
  verificationStatusTone,
} from "@/lib/account/profile-view";
import {
  avatarMessage,
  phoneOtpMessage,
  profileErrorMessage,
} from "@/lib/account/profile-messages";
import {
  ErrorState,
  Panel,
  StatusBadge,
  StatusMessage,
  btn,
  metaTextClass,
} from "@/components/ui/kit";

/**
 * EDIT PROFIL — the separate editing screen, reached from "Edit Profil" on the
 * Account & Access Center.
 *
 * Three groups, as decided for Tahap 3:
 *   1. Informasi Pribadi — photo, full name, username, date of birth;
 *   2. Kontak — the registered email READ-ONLY (changing it belongs to the
 *      account security flow, which this screen does not replace) and the phone;
 *   3. Verifikasi — the email and phone facts as the SERVER reports them.
 *
 * Every write goes to an existing endpoint and the server stays the authority:
 * `PATCH /api/account/profile` (self-owned columns only), `POST
 * /api/account/profile/avatar` (private bucket + signed URL) and the two phone
 * OTP endpoints. Nothing is verified on the client: a phone shows as verified
 * only when the SERVER says so after a successful OTP confirmation, and the
 * screen re-reads the server profile instead of assuming success.
 *
 * With no OTP provider configured (documented blocker B5) the server capability
 * probe is false, so the group states "Verifikasi nomor belum tersedia saat ini."
 * and NO send-code control is rendered — a button that is certain to fail is
 * worse than an honest status. The whole send → code → result flow is already
 * built and becomes reachable the moment the provider and secret exist.
 */

type Props = {
  fullName: string | null;
  username: string | null;
  email: string | null;
  dateOfBirth: string | null;
  age: number | null;
  phoneE164: string | null;
  avatarUrl: string | null;
  verification: AccountVerificationSummary;
  phoneVerificationAvailable: boolean;
};

const INPUT_CLASS =
  "w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm text-black/90 placeholder:text-black/30 focus:border-brand-accent focus:outline-none disabled:bg-black/[0.04] disabled:text-black/50";

function Group({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Panel className="grid gap-3">
      <div>
        <h2 className="text-sm font-bold text-brand-ink">{title}</h2>
        {description ? (
          <p className={`mt-0.5 text-black/55 ${metaTextClass}`}>{description}</p>
        ) : null}
      </div>
      {children}
    </Panel>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-xs font-semibold text-black/70" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? <p className={`text-black/45 ${metaTextClass}`}>{hint}</p> : null}
    </div>
  );
}

export default function AccountProfileEditClient({
  fullName,
  username,
  email,
  dateOfBirth,
  age,
  phoneE164,
  avatarUrl,
  verification,
  phoneVerificationAvailable,
}: Props) {
  const router = useRouter();

  const [savedFullName, setSavedFullName] = useState(fullName ?? "");
  const [savedUsername, setSavedUsername] = useState(username ?? "");
  const [savedDateOfBirth, setSavedDateOfBirth] = useState(dateOfBirth ?? "");
  const [savedPhone, setSavedPhone] = useState(phoneE164 ?? "");

  const [fullNameInput, setFullNameInput] = useState(fullName ?? "");
  const [usernameInput, setUsernameInput] = useState(username ?? "");
  const [dateOfBirthInput, setDateOfBirthInput] = useState(dateOfBirth ?? "");
  const [phoneInput, setPhoneInput] = useState(phoneE164 ?? "");

  const [saveState, setSaveState] = useState<"idle" | "saving" | "success" | "error">(
    "idle",
  );
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [currentAvatarUrl, setCurrentAvatarUrl] = useState(avatarUrl);
  const [avatarState, setAvatarState] = useState<"idle" | "uploading">("idle");
  const [avatarNote, setAvatarNote] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [otpState, setOtpState] = useState<
    "idle" | "sending" | "sent" | "verifying" | "error"
  >("idle");
  const [otpNote, setOtpNote] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);

  const displayName = accountProfileDisplayName({
    fullName: savedFullName,
    username: savedUsername,
    email,
  });
  const initials = accountProfileInitials({
    fullName: savedFullName,
    username: savedUsername,
    email,
  });

  async function uploadAvatar(file: File) {
    setAvatarState("uploading");
    setAvatarNote(null);
    setAvatarError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/account/profile/avatar", {
        method: "POST",
        body,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        avatarUrl?: string;
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        setAvatarState("idle");
        setAvatarError(payload.message ?? avatarMessage(payload.error));
        return;
      }
      // The short-lived signed URL comes from the server; the client never
      // builds a public URL for the private bucket.
      setCurrentAvatarUrl(payload.avatarUrl ?? null);
      setAvatarState("idle");
      setAvatarNote("Foto profil berhasil diperbarui.");
      router.refresh();
    } catch {
      setAvatarState("idle");
      setAvatarError(avatarMessage("avatar_upload_failed"));
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saveState === "saving") return;
    setSaveNote(null);
    setSaveError(null);

    const nextFullName = fullNameInput.trim();
    const nextUsername = usernameInput.trim();
    const nextDateOfBirth = dateOfBirthInput.trim();
    const nextPhone = phoneInput.trim();

    const update: Record<string, string> = {};
    if (nextFullName !== savedFullName.trim()) update.full_name = nextFullName;
    if (nextUsername !== savedUsername.trim()) update.username = nextUsername;
    if (nextDateOfBirth !== savedDateOfBirth.trim()) update.date_of_birth = nextDateOfBirth;
    if (nextPhone !== savedPhone.trim()) update.phone = nextPhone;

    if (Object.keys(update).length === 0) {
      setSaveState("error");
      setSaveError(profileErrorMessage("profile_update_empty"));
      return;
    }

    setSaveState("saving");
    try {
      const response = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        profile?: {
          fullName: string | null;
          username: string | null;
          dateOfBirth: string | null;
          phoneE164: string | null;
        };
      };
      if (!response.ok) {
        setSaveState("error");
        setSaveError(payload.message ?? profileErrorMessage(payload.error));
        return;
      }
      const saved = payload.profile;
      setSavedFullName(saved?.fullName ?? nextFullName);
      setSavedUsername(saved?.username ?? nextUsername);
      setSavedDateOfBirth(saved?.dateOfBirth ?? nextDateOfBirth);
      setSavedPhone(saved?.phoneE164 ?? nextPhone);
      setFullNameInput(saved?.fullName ?? nextFullName);
      setUsernameInput(saved?.username ?? nextUsername);
      setDateOfBirthInput(saved?.dateOfBirth ?? nextDateOfBirth);
      setPhoneInput(saved?.phoneE164 ?? nextPhone);
      setSaveState("success");
      setSaveNote(
        "phone" in update
          ? "Profil berhasil disimpan. Nomor telepon berubah, jadi verifikasinya direset — verifikasi ulang untuk mengaktifkannya."
          : "Profil berhasil disimpan.",
      );
      setChallengeId(null);
      setCode("");
      setOtpState("idle");
      setOtpNote(null);
      setOtpError(null);
      router.refresh();
    } catch {
      setSaveState("error");
      setSaveError(profileErrorMessage("profile_update_unavailable"));
    }
  }

  async function sendCode() {
    if (otpState === "sending") return;
    setOtpNote(null);
    setOtpError(null);
    setOtpState("sending");
    try {
      const response = await fetch("/api/account/phone/otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phoneInput.trim() }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
        challengeId?: string | null;
      };
      if (payload.status === "phone_otp_sent" && payload.challengeId) {
        setChallengeId(payload.challengeId);
        setOtpState("sent");
        setOtpNote(payload.message ?? phoneOtpMessage("phone_otp_sent"));
        return;
      }
      setOtpState("error");
      setOtpError(payload.message ?? phoneOtpMessage(payload.status));
    } catch {
      setOtpState("error");
      setOtpError(phoneOtpMessage("phone_otp_unavailable"));
    }
  }

  async function verifyCode() {
    if (!challengeId || otpState === "verifying") return;
    setOtpNote(null);
    setOtpError(null);
    setOtpState("verifying");
    try {
      const response = await fetch("/api/account/phone/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, code: code.trim() }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
        phoneVerified?: boolean;
      };
      if (payload.status === "phone_otp_verified") {
        setChallengeId(null);
        setCode("");
        setOtpState("idle");
        setOtpNote(payload.message ?? phoneOtpMessage("phone_otp_verified"));
        // The verified badge is NOT set here — the server profile is re-read and
        // the status comes back from stored data only.
        router.refresh();
        return;
      }
      setOtpState("sent");
      setOtpError(payload.message ?? phoneOtpMessage(payload.status));
    } catch {
      setOtpState("sent");
      setOtpError(phoneOtpMessage("phone_otp_unavailable"));
    }
  }

  const phoneChanged = phoneInput.trim() !== savedPhone.trim();

  return (
    <form className="grid gap-4" onSubmit={save}>
      {/* 1. Informasi Pribadi */}
      <Group
        title="Informasi Pribadi"
        description="Data ini tampil di akunmu dan disimpan di server setelah kamu menekan Simpan."
      >
        <div className="flex items-center gap-3.5">
          {currentAvatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- private-bucket signed URL
            <img
              src={currentAvatarUrl}
              alt="Foto profil"
              className="h-14 w-14 shrink-0 rounded-full border border-black/10 object-cover"
            />
          ) : (
            <span
              className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-brand-accent text-base font-bold text-white"
              aria-hidden
            >
              {initials}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-bold text-brand-ink">
              {displayName}
            </span>
            <span className={`mt-0.5 block break-words text-black/55 ${metaTextClass}`}>
              JPEG, PNG, atau WebP, maksimal 2 MB.
            </span>
          </span>
        </div>

        <div className="grid gap-1.5">
          <label className="text-xs font-semibold text-black/70" htmlFor="profile-avatar">
            Foto profil
          </label>
          <input
            id="profile-avatar"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={avatarState === "uploading"}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadAvatar(file);
            }}
            className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-xs file:mr-3 file:rounded-full file:border-0 file:bg-brand-accent/10 file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-brand-accent"
          />
          {avatarState === "uploading" ? (
            <StatusMessage message="Mengunggah foto profil…" />
          ) : null}
          {avatarNote ? <StatusMessage message={avatarNote} /> : null}
          {avatarError ? <ErrorState message={avatarError} /> : null}
        </div>

        <Field id="profile-full-name" label="Nama lengkap">
          <input
            id="profile-full-name"
            type="text"
            value={fullNameInput}
            onChange={(event) => setFullNameInput(event.target.value)}
            placeholder="Nama lengkapmu"
            className={INPUT_CLASS}
          />
        </Field>

        <Field
          id="profile-username"
          label="Username"
          hint="Username adalah label publik akun ini dan dapat diubah kapan saja."
        >
          <input
            id="profile-username"
            type="text"
            value={usernameInput}
            onChange={(event) => setUsernameInput(event.target.value)}
            placeholder="pilih-username"
            className={INPUT_CLASS}
          />
        </Field>

        <Field
          id="profile-date-of-birth"
          label="Tanggal lahir"
          hint={
            age !== null
              ? `Usia saat ini ${age} tahun, dihitung di server. Tanggal lahir tidak pernah ditampilkan publik.`
              : "Usia dihitung di server dari tanggal ini dan tidak pernah ditampilkan publik."
          }
        >
          <input
            id="profile-date-of-birth"
            type="date"
            value={dateOfBirthInput}
            onChange={(event) => setDateOfBirthInput(event.target.value)}
            className={INPUT_CLASS}
          />
        </Field>
      </Group>

      {/* 2. Kontak */}
      <Group title="Kontak">
        <Field
          id="profile-email"
          label="Email"
          hint="Email adalah identitas masuk akun ini. Perubahannya hanya lewat alur keamanan akun, bukan dari halaman ini."
        >
          <input
            id="profile-email"
            type="email"
            value={email ?? ""}
            readOnly
            disabled
            aria-describedby="profile-email-note"
            className={INPUT_CLASS}
          />
        </Field>

        <Field
          id="profile-phone"
          label="Nomor telepon"
          hint="Gunakan format internasional, misalnya +628123456789."
        >
          <input
            id="profile-phone"
            type="tel"
            inputMode="tel"
            value={phoneInput}
            onChange={(event) => setPhoneInput(event.target.value)}
            placeholder="+628123456789"
            className={INPUT_CLASS}
          />
        </Field>
      </Group>

      {/* 3. Verifikasi */}
      <Group
        title="Verifikasi"
        description="Status di bawah ini berasal dari data server, bukan dari isian di halaman ini."
      >
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold text-black/70">Email</span>
            <span className={`block break-words text-black/55 ${metaTextClass}`}>
              {verification.email.value ?? "Belum ada"}
            </span>
          </span>
          <StatusBadge
            tone={verificationStatusTone(
              verification.email.value,
              verification.email.verified,
            )}
          >
            {verificationStatusLabel(
              verification.email.value,
              verification.email.verified,
            )}
          </StatusBadge>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold text-black/70">Nomor telepon</span>
            <span className={`block break-words text-black/55 ${metaTextClass}`}>
              {verification.phone.value ?? "Belum ada"}
            </span>
          </span>
          <StatusBadge
            tone={verificationStatusTone(
              verification.phone.value,
              verification.phone.verified,
            )}
          >
            {verificationStatusLabel(
              verification.phone.value,
              verification.phone.verified,
            )}
          </StatusBadge>
        </div>

        {!phoneVerificationAvailable ? (
          <StatusMessage
            message={phoneOtpMessage("phone_otp_provider_not_configured")}
          />
        ) : (
          <div className="grid gap-2 border-t border-black/10 pt-3">
            <span className="text-xs font-semibold text-black/70">
              Verifikasi nomor telepon
            </span>

            {challengeId === null ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={sendCode}
                  disabled={otpState === "sending" || !phoneInput.trim()}
                  className={btn.secondary}
                >
                  {otpState === "sending" ? "Mengirim kode…" : "Kirim kode verifikasi"}
                </button>
                {phoneChanged ? (
                  <span className={`text-black/45 ${metaTextClass}`}>
                    Simpan nomor terlebih dahulu agar kode dikirim ke nomor baru.
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="grid gap-2">
                <Field id="profile-otp-code" label="Kode verifikasi">
                  <input
                    id="profile-otp-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="Kode dari SMS"
                    className={INPUT_CLASS}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={verifyCode}
                    disabled={otpState === "verifying" || !code.trim()}
                    className={btn.primary}
                  >
                    {otpState === "verifying" ? "Memeriksa…" : "Verifikasi"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setChallengeId(null);
                      setCode("");
                      setOtpState("idle");
                      setOtpNote(null);
                      setOtpError(null);
                    }}
                    className={btn.secondary}
                  >
                    Batal
                  </button>
                </div>
              </div>
            )}

            {otpNote ? <StatusMessage message={otpNote} /> : null}
            {otpError ? <ErrorState message={otpError} /> : null}
          </div>
        )}
      </Group>

      {saveState === "error" && saveError ? <ErrorState message={saveError} /> : null}
      {saveState === "success" && saveNote ? <StatusMessage message={saveNote} /> : null}

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={saveState === "saving"} className={btn.primary}>
          {saveState === "saving" ? "Menyimpan…" : "Simpan"}
        </button>
        <Link href="/account" className={btn.secondary}>
          Batal
        </Link>
      </div>
    </form>
  );
}
