"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UsernameValidationError, validateUsername } from "@/lib/username";

type Props = {
  username: string | null;
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
    "Tidak dapat menyimpan username saat ini.",
};

/**
 * Profil — self-service editing of the ONE profile field the canonical schema
 * actually supports: `public.users.username`.
 *
 * The value is pre-filled from the server row, so "read existing values" and
 * "edit existing values" are the same control instead of a read-only label you
 * could never change. Email and password are NOT part of this surface and are
 * not editable here. The row that gets written is decided server-side
 * (`/api/account/username` updates only the caller's own id), and username
 * uniqueness is enforced by the database's partial unique index.
 */
export default function AccountProfileClient({ username }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">(
    "idle",
  );
  const [errorKey, setErrorKey] = useState<AccountProfileError | null>(null);
  const [pending, setPending] = useState(username ?? "");
  const [saved, setSaved] = useState(username ?? "");

  async function save() {
    const trimmed = pending.trim();
    const validation = validateUsername(trimmed);
    if (validation) {
      setErrorKey(validation);
      return;
    }
    if (trimmed === saved) {
      setStatus("success");
      setErrorKey(null);
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
      router.refresh();
    } catch {
      setStatus("error");
      setErrorKey("username_update_unavailable");
    }
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <label
          className="text-xs font-semibold text-black/70"
          htmlFor="account-username"
        >
          Username
        </label>
        <div className="flex gap-2">
          <input
            id="account-username"
            type="text"
            value={pending}
            onChange={(event) => setPending(event.target.value)}
            disabled={status === "loading"}
            className="flex-1 rounded-xl border border-black/10 bg-white px-3 py-2 text-sm text-black/90 placeholder:text-black/30 focus:border-brand-accent focus:outline-none"
            placeholder="pilih-username"
          />
          <button
            type="button"
            onClick={save}
            disabled={status === "loading" || !pending.trim()}
            className="shrink-0 rounded-xl bg-brand-primary px-3.5 py-2 text-sm font-bold text-white transition hover:bg-brand-primary-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "loading" ? "Menyimpan…" : "Simpan"}
          </button>
        </div>
        <p className="text-[11px] text-black/45">
          Username adalah label publik akun ini dan dapat diubah kapan saja.
        </p>
      </div>

      {status === "success" ? (
        <p className="text-xs text-black/60" role="status">
          Username berhasil disimpan.
        </p>
      ) : status === "error" || errorKey ? (
        <p className="text-xs font-semibold text-red-800" role="alert">
          {USERNAME_ERROR_LABELS[errorKey ?? "username_update_unavailable"]}
        </p>
      ) : null}
    </div>
  );
}
