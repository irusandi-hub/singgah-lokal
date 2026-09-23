"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

/**
 * Developer Center — Platform Admin management (Authority Master §2/§8).
 *
 * The Creator grants and revokes platform_moderator from this UI — no SQL
 * Editor. Every action hits /api/developer/platform-admins, which re-verifies
 * Creator authorization server-side; this form only renders server answers
 * and never sees any credential.
 */

type AdminRow = {
  userId: string;
  email: string | null;
  platformRole: string | null;
  createdAt: string;
  source: string;
};

const errorMessages: Record<string, string> = {
  creator_required: "Akses Creator diperlukan.",
  email_invalid: "Email tidak valid.",
  account_not_found: "Akun dengan email tersebut tidak ditemukan.",
  creator_account: "Akun Creator tidak dapat dijadikan Platform Admin.",
  service_not_configured:
    "Server produksi belum terkonfigurasi: SUPABASE_SERVICE_ROLE_KEY tidak tersedia. Tambahkan di Vercel → Settings → Environment Variables (Production), lalu deploy ulang.",
  lookup_failed: "Pemeriksaan akun gagal. Coba lagi.",
  list_failed: "Daftar Platform Admin tidak dapat dimuat.",
  grant_failed: "Pemberian role gagal. Coba lagi.",
  revoke_failed: "Pencabutan role gagal. Coba lagi.",
};

function messageFor(code: string | null): string {
  if (!code) return "Terjadi kesalahan. Coba lagi.";
  return errorMessages[code] ?? "Terjadi kesalahan. Coba lagi.";
}

export default function DeveloperPlatformAdmins({ creatorEmail }: { creatorEmail: string }) {
  const [rows, setRows] = useState<AdminRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fetchAdmins = useCallback(async (): Promise<AdminRow[]> => {
    const response = await fetch("/api/developer/platform-admins");
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error ?? "list_failed");
    }
    const payload = (await response.json()) as { admins: AdminRow[] };
    return payload.admins;
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchAdmins());
    } catch (requestError) {
      setError(messageFor(requestError instanceof Error ? requestError.message : null));
    } finally {
      setLoading(false);
    }
  }, [fetchAdmins]);

  // Fetch the Platform Admin list once on mount — without this the dashboard
  // stays stuck on "Memuat…". Every state update happens after the await
  // boundary (nothing synchronous inside the effect), and the cancelled guard
  // drops a late response from an already-unmounted first render.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const admins = await fetchAdmins();
        if (!cancelled) setRows(admins);
      } catch (requestError) {
        if (!cancelled) setError(messageFor(requestError instanceof Error ? requestError.message : null));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchAdmins]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/developer/platform-admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(messageFor(payload.error ?? null));
        return;
      }
      setNotice(`Role Platform Admin diberikan ke ${email.trim()}.`);
      setEmail("");
      await refresh();
    } catch {
      setError(messageFor("grant_failed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(row: AdminRow) {
    if (!row.email || submitting) return;
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/developer/platform-admins", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: row.email }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(messageFor(payload.error ?? null));
        return;
      }
      setNotice(`Role Platform Admin dicabut dari ${row.email}.`);
      await refresh();
    } catch {
      setError(messageFor("revoke_failed"));
    } finally {
      setSubmitting(false);
    }
  }

  if (rows === null) {
    return (
      <div className="rounded-2xl border border-[#20231f]/10 bg-white p-6 shadow-[0_1px_2px_rgba(32,35,31,0.06)]">
        <p className={`text-sm font-semibold ${error ? "text-[#b3261e]" : "text-[#20231f]/60"}`}>
          {error ?? "Memuat…"}
        </p>
        {!loading ? (
          <button
            type="button"
            onClick={refresh}
            className="mt-4 rounded-full bg-brand-primary px-4 py-2 text-xs font-bold text-white transition hover:bg-[#0a5640]"
          >
            Coba muat ulang
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <section className="space-y-6" aria-label="Pengelolaan Platform Admin">
      <div className="rounded-2xl border border-[#20231f]/10 bg-white p-6 shadow-[0_1px_2px_rgba(32,35,31,0.06)]">
        <h2 className="text-lg font-black text-[#20231f]">Platform Admin</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#20231f]/60">
          Berikan atau cabut role <span className="font-mono text-brand-accent">platform_moderator</span> pada akun
          terdaftar. Role ini adalah kewenangan operasional di dalam aplikasi (Admin Center) — bukan kewenangan
          infrastruktur. Perubahan berlaku saat akun tersebut membuka area Admin.
        </p>

        <form className="mt-5 flex flex-col gap-3 sm:flex-row" onSubmit={submit}>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="email akun yang diberi role"
            aria-label="Email akun Platform Admin baru"
            className="w-full rounded-xl border border-[#20231f]/15 bg-white px-4 py-2.5 text-sm text-[#20231f] placeholder:text-[#20231f]/35 focus:border-brand-primary focus:outline-none sm:max-w-md"
          />
          <button
            type="submit"
            disabled={submitting}
            className="shrink-0 rounded-xl bg-brand-primary px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#0a5640] disabled:opacity-60"
          >
            {submitting ? "Memproses…" : "Grant Platform Admin"}
          </button>
        </form>

        {notice ? <p className="mt-3 text-sm font-semibold text-[#1f6b3f]" role="status">{notice}</p> : null}
        {error ? <p className="mt-3 text-sm font-semibold text-[#b3261e]" role="alert">{error}</p> : null}
      </div>

      <div className="rounded-2xl border border-[#20231f]/10 bg-white shadow-[0_1px_2px_rgba(32,35,31,0.06)]">
        <div className="flex items-center justify-between gap-3 border-b border-[#20231f]/10 px-6 py-4">
          <h3 className="text-sm font-bold uppercase tracking-[0.14em] text-[#20231f]/70">Role aktif</h3>
          <button
            type="button"
            onClick={refresh}
            className="rounded-full border border-[#20231f]/15 px-3 py-1.5 text-xs font-bold text-[#20231f]/70 transition hover:bg-[#20231f]/5"
          >
            Muat ulang
          </button>
        </div>

        {loading ? (
          <p className="px-6 py-6 text-sm text-[#20231f]/60">Memuat…</p>
        ) : rows.length === 0 ? (
          <p className="px-6 py-6 text-sm text-[#20231f]/60">
            Belum ada Platform Admin. Berikan role lewat formulir di atas.
          </p>
        ) : (
          <ul className="divide-y divide-[#20231f]/10">
            {rows.map((row) => (
              <li key={row.userId} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[#20231f]">{row.email ?? "email tidak tersedia"}</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-[#20231f]/45">
                    {row.userId} · sejak {new Date(row.createdAt).toLocaleDateString("id-ID")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => revoke(row)}
                  disabled={submitting}
                  className="rounded-full border border-[#b3261e]/40 px-4 py-2 text-xs font-bold text-[#b3261e] transition hover:bg-[#b3261e]/10 disabled:opacity-50"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs leading-5 text-[#20231f]/40">
        Masuk sebagai {creatorEmail}. Kredensial infrastruktur (GitHub, Vercel, Supabase, DNS, secrets) tetap
        dikelola di luar aplikasi sesuai Authority Master.
      </p>
    </section>
  );
}
