"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * PERSETUJUAN DOKUMEN HUKUM (klien).
 *
 * Satu-satunya tindakan yang bisa diambil di sini adalah menyatakan persetujuan
 * atas VERSI YANG BERLAKU yang sudah ditentukan server. Versi itu dikirim balik
 * ke server sebagai penanda saja: route memvalidasinya ulang terhadap register
 * dokumen, jadi komponen ini tidak dapat menandai persetujuan untuk versi lain.
 * Setelah server mengonfirmasi, halaman di-refresh sehingga keadaan yang
 * ditampilkan datang dari server, bukan dari state klien.
 */
export default function LegalAcceptancePrompt({
  documentId,
  title,
  version,
  href,
}: {
  documentId: string;
  title: string;
  version: string;
  href: string;
}) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch("/api/legal/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, version }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(typeof payload.error === "string" ? payload.error : "Persetujuan gagal dicatat.");
        return;
      }
      router.refresh();
    } catch {
      setError("Persetujuan gagal dicatat. Coba lagi.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4" data-testid="legal-acceptance-prompt">
      <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-amber-800">
        Persetujuan diperlukan
      </p>
      <h3 className="mt-1 text-sm font-bold text-amber-900">
        {title} versi {version}
      </h3>
      <p className="mt-1.5 text-xs leading-5 text-amber-900/80">
        Akun ini belum menyatakan persetujuan atas versi yang berlaku. Baca dokumennya lebih dulu,
        lalu nyatakan persetujuan. Dokumen ini menunggu peninjauan hukum.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link
          href={href}
          className="rounded-full border border-amber-300 bg-white px-3.5 py-1.5 text-xs font-bold text-amber-900"
        >
          Baca {title}
        </Link>
        <button
          type="button"
          onClick={() => void accept()}
          disabled={working}
          className="rounded-full bg-brand-primary px-3.5 py-1.5 text-xs font-bold text-white disabled:opacity-60"
        >
          {working ? "Menyimpan…" : "Saya menyetujui"}
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-xs font-semibold text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
