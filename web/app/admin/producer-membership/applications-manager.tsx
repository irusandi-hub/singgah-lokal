"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Admin approval panel for Producer applications (Platform Moderator only —
 * the API enforces it; this panel is just the surface). Approving activates
 * producer_memberships for the APPLICANT's user_id — no auth account, email,
 * or password is ever created.
 */

type Application = {
  id: string;
  userId: string;
  status: string;
  contactEmail: string | null;
  createdAt: string;
};

type PlaceOption = { id: string; name: string; producerId: string | null };

type Feedback = { kind: "ok" | "error"; message: string } | null;

export default function ProducerApplicationsManager({ places }: { places: PlaceOption[] }) {
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [placesById, setPlacesById] = useState("");

  const fetchApplications = useCallback(async (): Promise<Application[] | null> => {
    try {
      const response = await fetch("/api/admin/producer-applications");
      if (!response.ok) return null;
      const payload: unknown = await response.json().catch(() => null);
      if (!payload || typeof payload !== "object" || !("applications" in payload)) return null;
      return (payload as { applications: Application[] }).applications ?? [];
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await fetchApplications();
      if (cancelled) return;
      if (rows === null) {
        setLoadFailed(true);
      } else {
        setApplications(rows);
        setLoadFailed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchApplications]);

  async function approve(applicationId: string) {
    const producerId = placesById.trim();
    const place = places.find((item) => item.id === placesById);
    if (!producerId || !place) {
      setFeedback({ kind: "error", message: "Pilih Place tujuan terlebih dahulu." });
      return;
    }
    setBusyId(applicationId);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/producer-applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicationId,
          producerId: place.producerId ?? producerId,
          placeId: place.id,
          role: "owner",
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const base =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error)
            : "Approval gagal. Coba lagi.";
        setFeedback({ kind: "error", message: base });
        return;
      }
      // Server confirmed the approval; refresh the pending list and report.
      const rows = await fetchApplications();
      setApplications(rows ?? []);
      setFeedback({
        kind: "ok",
        message: "Berhasil menyetujui. Membership Producer aktif untuk akun pengaju (user_id sama) — tanpa akun baru.",
      });
      setPlacesById("");
    } catch {
      setFeedback({ kind: "error", message: "Tidak dapat menghubungi server." });
    } finally {
      setBusyId(null);
    }
  }

  if (loadFailed) {
    return (
      <section className="rounded-2xl border border-black/10 bg-white p-5">
        <p className="text-sm font-semibold text-red-800" role="alert">
          Daftar pengajuan tidak dapat dimuat. Periksa bahwa migration 0016 sudah diterapkan.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-black/10 bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-black/50">Pengajuan Producer</h2>
      <p className="mt-1 text-xs leading-5 text-black/55">
        Menyetujui akan mengaktifkan membership untuk user_id pengaju — akun SINGGAH LOKAL yang sama
        otomatis memperoleh akses Producer. Tidak ada akun atau password baru yang dibuat.
      </p>

      {applications === null ? (
        <p className="mt-4 text-sm font-semibold text-black/60" role="status">
          Memuat…
        </p>
      ) : applications.length === 0 ? (
        <p className="mt-4 text-sm text-black/60" role="status">
          Tidak ada pengajuan pending.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-black/5">
          {applications.map((application) => (
            <li key={application.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-black/80">
                    {application.contactEmail ?? "Akun SINGGAH LOKAL"}
                  </p>
                  <p className="font-mono text-xs text-black/50">user {application.userId.slice(0, 8)}…</p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    aria-label="Place untuk membership"
                    className="rounded-xl border border-black/10 bg-white px-3 py-2 text-xs font-semibold text-black/75"
                    value={placesById}
                    onChange={(event) => setPlacesById(event.target.value)}
                  >
                    <option value="">Pilih Place…</option>
                    {places.map((place) => (
                      <option key={place.id} value={place.id}>
                        {place.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busyId === application.id}
                    onClick={() => void approve(application.id)}
                    className="rounded-xl bg-brand-primary px-3 py-2 text-xs font-bold text-white transition hover:bg-brand-primary-deep disabled:opacity-50"
                  >
                    {busyId === application.id ? "Memproses…" : "Setujui"}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {feedback ? (
        <p
          className={`mt-3 rounded-xl border px-3 py-2 text-xs font-semibold ${
            feedback.kind === "ok"
              ? "border-brand-primary/30 bg-brand-primary/10 text-brand-primary"
              : "border-red-800/30 bg-red-800/10 text-red-800"
          }`}
          role="status"
        >
          {feedback.message}
        </p>
      ) : null}
    </section>
  );
}
