"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Producer application panel (client). One action: file the application for
 * the signed-in account. Success feedback appears only after the server
 * confirms; the status shown comes from the account's own application record.
 */

type Status = "none" | "pending" | "approved" | "rejected";

const STATUS_TEXT: Record<Status, string> = {
  none: "Belum ada pengajuan untuk akun ini.",
  pending: "Pengajuan menunggu verifikasi admin.",
  approved: "Pengajuan disetujui — membership Producer aktif untuk akun ini.",
  rejected: "Pengajuan sebelumnya ditolak. Kamu bisa mengajukan kembali.",
};

export default function ProducerApplicationClient({
  initialStatus,
  serviceAvailable,
}: {
  initialStatus: Status;
  serviceAvailable: boolean;
}) {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [reloadFailed, setReloadFailed] = useState(false);
  const statusRef = useRef(initialStatus);

  // Keep the panel honest on refresh: re-read the account's own status.
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/producer/application");
      if (!response.ok) {
        setReloadFailed(true);
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (payload && typeof payload === "object" && "application" in payload) {
        const application = (payload as { application?: { status?: Status } }).application;
        if (application?.status) {
          statusRef.current = application.status;
          setStatus(application.status);
          setReloadFailed(false);
        }
      }
    } catch {
      setReloadFailed(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/producer/application", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() || undefined }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code =
          payload && typeof payload === "object" && "code" in payload
            ? String((payload as { code?: unknown }).code)
            : "";
        const base =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error)
            : "Pengajuan gagal. Coba lagi.";
        if (code === "authentication_required") {
          setFeedback({ kind: "error", message: "Sesi berakhir. Masuk kembali lalu ajukan lagi." });
        } else {
          setFeedback({ kind: "error", message: base });
        }
        return;
      }
      // Server confirmed the application exists (201).
      statusRef.current = "pending";
      setStatus("pending");
      setFeedback({ kind: "ok", message: "Berhasil dikirim. Pengajuan menunggu verifikasi admin." });
      setNote("");
    } catch {
      setFeedback({ kind: "error", message: "Tidak dapat menghubungi server. Coba lagi." });
    } finally {
      setSubmitting(false);
    }
  }

  if (!serviceAvailable || reloadFailed) {
    return (
      <p className="mt-4 rounded-xl border border-red-800/30 bg-red-800/10 px-4 py-3 text-sm font-semibold text-red-800" role="alert">
        Layanan pengajuan belum tersedia. Coba lagi nanti.
      </p>
    );
  }

  return (
    <div className="mt-4">
      <p
        role="status"
        className={`rounded-xl border px-4 py-3 text-sm font-semibold ${
          status === "approved"
            ? "border-brand-primary/30 bg-brand-primary/10 text-brand-primary"
            : "border-black/10 bg-brand-cream text-brand-ink"
        }`}
      >
        {STATUS_TEXT[status]}
      </p>

      {status === "pending" || status === "approved" ? (
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-3 rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-bold text-black/70 hover:bg-black/5"
        >
          Muat ulang status
        </button>
      ) : (
        <form className="mt-4 space-y-3" onSubmit={submit}>
          <label className="block text-sm font-semibold" htmlFor="producer-note">
            Catatan untuk admin (opsional)
            <textarea
              className="mt-1 w-full rounded-xl border border-black/10 bg-white px-3 py-2 font-normal"
              id="producer-note"
              maxLength={1000}
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Place yang ingin dikelola, bukti pengelolaan, dsb."
            />
          </label>
          <button
            className="rounded-2xl bg-brand-primary px-5 py-2.5 text-sm font-bold text-white transition hover:bg-brand-primary-deep disabled:opacity-60"
            disabled={submitting}
            type="submit"
          >
            {submitting ? "Mengirim…" : status === "rejected" ? "Ajukan kembali" : "Kirim pengajuan"}
          </button>
        </form>
      )}

      {feedback ? (
        <p
          className={`mt-3 rounded-xl border px-3 py-2 text-sm font-semibold ${
            feedback.kind === "ok"
              ? "border-brand-primary/30 bg-brand-primary/10 text-brand-primary"
              : "border-red-800/30 bg-red-800/10 text-red-800"
          }`}
          role="status"
        >
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}
