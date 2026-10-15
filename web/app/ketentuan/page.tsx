import Link from "next/link";
import { PageHeader, PageShell, backLinkClass } from "@/components/ui/kit";
import { KETENTUAN_PENGGUNAAN, LEGAL_REVIEW_NOTICE } from "@/lib/legal/documents";
import { readLegalDocumentRegistry } from "@/lib/legal/acceptance";
import { formatPlaceDate } from "@/lib/display-format";

export const dynamic = "force-dynamic";

/**
 * KETENTUAN PENGGUNAAN — the public, versioned legal document surface.
 *
 * The prose has ONE source (`lib/legal/documents.ts`); the VERSION and effective
 * date shown here come from the document register (`legal_documents`, migration
 * 0059), so the page can never claim a version the platform does not consider
 * current. When the register is not yet available in an environment the page
 * still renders and says so, instead of failing or inventing a version.
 *
 * The document is explicitly marked as awaiting legal review. Nothing here may
 * state or imply that the wording has been legally reviewed.
 */
export default async function KetentuanPage() {
  const registry = await readLegalDocumentRegistry({ documentId: KETENTUAN_PENGGUNAAN.id });
  const effectiveLabel = formatPlaceDate(registry.effectiveAt.slice(0, 10));

  return (
    <PageShell width="narrow">
      <PageHeader
        back={
          <Link className={backLinkClass} href="/">
            ← Beranda
          </Link>
        }
        title={KETENTUAN_PENGGUNAAN.title}
        description={KETENTUAN_PENGGUNAAN.summary}
      />

      <div className="mt-4 grid gap-4">
        <section className="rounded-2xl border border-black/10 bg-white p-4">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-black/45">
            Versi berlaku
          </p>
          <p className="mt-1 text-sm font-semibold" data-testid="ketentuan-version">
            Versi {registry.version} · berlaku {effectiveLabel}
          </p>
          {!registry.available ? (
            <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-800" role="status">
              Register versi dokumen belum tersedia di lingkungan ini. Versi yang ditampilkan
              mengikuti versi dokumen yang tertanam di aplikasi.
            </p>
          ) : null}
          <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-800" data-testid="ketentuan-legal-review">
            {LEGAL_REVIEW_NOTICE}
          </p>
        </section>

        {KETENTUAN_PENGGUNAAN.sections.map((section) => (
          <section
            key={section.heading}
            className="border-t border-black/10 pt-4 first:border-t-0 first:pt-0"
          >
            <h2 className="text-[15px] font-semibold">{section.heading}</h2>
            <div className="mt-1.5 grid gap-2">
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph} className="text-sm leading-6 text-black/60">
                  {paragraph}
                </p>
              ))}
            </div>
          </section>
        ))}

        <section className="border-t border-black/10 pt-4">
          <h2 className="text-[15px] font-semibold">Dokumen terkait</h2>
          <p className="mt-1.5 text-sm leading-6 text-black/60">
            Retensi arsip klaim Tempat, sifat privat bukti kepemilikan, dan batas tanggung jawab
            platform dirangkum di{" "}
            <Link href="/policy" className="font-bold text-brand-primary underline underline-offset-2">
              Kebijakan Data &amp; Klaim Tempat
            </Link>
            . Persetujuan atas ketentuan ini dicatat pada akun dan dapat dilihat di{" "}
            <Link href="/account" className="font-bold text-brand-primary underline underline-offset-2">
              Akun &amp; Akses
            </Link>
            .
          </p>
        </section>
      </div>
    </PageShell>
  );
}
