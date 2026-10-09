"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UsernameValidationError, validateUsername } from "@/lib/username";
import { btn, metaTextClass } from "@/components/ui/kit";

type Props = {
  username: string | null;
  email: string | null;
};

type AccountProfileError =
  | UsernameValidationError
  | "username_update_unavailable";

const USERNAME_ERROR_LABELS: Readonly<
  Record<AccountProfileError, string>
> = {
  username_required: "Username wajib diisi.",
  username_invalid:
    "Username hanya boleh huruf, angka, dan tanda hubung, dan harus antara 3 hingga 30 karakter.",
  username_taken: "Username sudah digunakan akun lain.",
  username_update_unavailable:
    "Tidak dapat menyimpan username saat ini. Coba lagi sebentar lagi.",
};

/**
 * Initials for the circular avatar. No avatar image is supported by the
 * canonical schema, so the avatar is the account's own initials — never an
 * invented photo. Falls back from username → email local part → a single
 * neutral glyph.
 */
function initialsFor(username: string | null, email: string | null): string {
  const source = (username ?? "").trim() || (email ?? "").split("@")[0] || "";
  const segments = source.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (segments.length === 0) return "?";
  const letters = segments
    .slice(0, 2)
    .map((segment) => segment.slice(0, 2))
    .join("");
  return letters.toUpperCase() || "?";
}

/**
 * PROFIL SAYA — the profile header of the Account & Access Center, with
 * self-service editing of the ONE profile field the canonical schema actually
 * supports: `public.users.username`.
 *
 * Read and edit are the SAME control: the input is pre-filled from the server
 * row, "Edit Profil" opens it, "Simpan" saves through the existing
 * `/api/account/username` route (which updates only the caller's own row) and
 * "Batal" restores the saved value. Email is displayed, never editable here —
 * it is the authenticated identity, not a profile field. Validation, saving,
 * success, and error states are all explicit.
 */
export default function AccountProfileClient({ username, email }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">(
    "idle",
  );
  const [errorKey, setErrorKey] = useState<AccountProfileError | null>(null);
  const [pending, setPending] = useState(username ?? "");
  const [saved, setSaved] = useState(username ?? "");

  const profileName = saved.trim() || email?.trim() || "Akun SINGGAH LOKAL";

  function startEditing() {
    setPending(saved);
    setErrorKey(null);
    setStatus("idle");
    setEditing(true);
  }

  function cancelEditing() {
    setPending(saved);
    setErrorKey(null);
    setStatus("idle");
    setEditing(false);
  }

  async function save() {
    const trimmed = pending.trim();
    const validation = validateUsername(trimmed);
    if (validation) {
      setStatus("error");
      setErrorKey(validation);
      return;
    }
    if (trimmed === saved) {
      setEditing(false);
      setErrorKey(null);
      setStatus("idle");
      return;
    }
    setStatus("loading");
    setErrorKey(null);
    try {
      const response = await fetch("/api/account/username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: trimmed }),
      });
      const payload = (await response.json()) as {
        error?: string;
        username?: string;
      };
      if (!response.ok) {
        setStatus("error");
        setErrorKey(
          (payload.error as AccountProfileError) ??
            "username_update_unavailable",
        );
        return;
      }
      setSaved(payload.username ?? trimmed);
      setPending(payload.username ?? trimmed);
      setStatus("success");
      setEditing(false);
      router.refresh();
    } catch {
      setStatus("error");
      setErrorKey("username_update_unavailable");
    }
  }

  if (!editing) {
    return (
      <div className="grid gap-2">
        <div className="flex items-center gap-3.5">
          <span
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand-accent text-base font-bold text-white"
            aria-hidden
          >
            {initialsFor(saved, email)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-bold text-brand-ink">
              {profileName}
            </span>
            {email && saved.trim() ? (
              <span className={`mt-0.5 block break-words text-black/55 ${metaTextClass}`}>
                {email}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={startEditing}
            className={`shrink-0 ${btn.secondary}`}
          >
            Edit Profil
          </button>
        </div>

        {status === "success" ? (
          <p className="text-xs font-semibold text-brand-primary" role="status">
            Username berhasil disimpan.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3.5">
        <span
          className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand-accent text-base font-bold text-white"
          aria-hidden
        >
          {initialsFor(saved, email)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-bold text-brand-ink">              {profileName}
            </span>
            {email ? (
            <span className={`mt-0.5 block break-words text-black/55 ${metaTextClass}`}>
              {email}
            </span>
          ) : null}
        </span>
      </div>

      <div className="grid gap-1.5">
        <label
          className="text-xs font-semibold text-black/70"
          htmlFor="account-username"
        >
          Username
        </label>
        <input
          id="account-username"
          type="text"
          value={pending}
          onChange={(event) => setPending(event.target.value)}
          disabled={status === "loading"}
          className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm text-black/90 placeholder:text-black/30 focus:border-brand-accent focus:outline-none"
          placeholder="pilih-username"
        />
        <p className="text-[11px] text-black/45">
          Username adalah label publik akun ini dan dapat diubah kapan saja.
        </p>
      </div>

      {status === "error" && errorKey ? (
        <p className="text-xs font-semibold text-red-800" role="alert">
          {USERNAME_ERROR_LABELS[errorKey ?? "username_update_unavailable"]}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={save}
          disabled={status === "loading" || !pending.trim()}
          className={btn.primary}
        >
          {status === "loading" ? "Menyimpan…" : "Simpan"}
        </button>
        <button
          type="button"
          onClick={cancelEditing}
          disabled={status === "loading"}
          className={btn.secondary}
        >
          Batal
        </button>
      </div>
    </div>
  );
}
