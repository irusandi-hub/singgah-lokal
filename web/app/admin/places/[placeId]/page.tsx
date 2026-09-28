import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminErrorState, AdminPageHeader, AdminStatusBadge, formatAdminTimestamp } from "@/components/admin/ui";
import AdminPlaceEditor from "@/components/admin/place-editor";
import AdminPlaceModeration from "@/components/admin/place-moderation";
import { getAdminPlaceDetail } from "@/lib/admin/place-workspace";
import { isPlacePublicationReady, type PublicationStatus } from "@/lib/places";
import { publicationStatusLabel } from "@/lib/status-labels";
import { timezoneLabel } from "@/lib/display-format";

export const dynamic = "force-dynamic";

/**
 * ADMIN PLACE DETAIL — the operational workspace for one Place
 * (Authority Master §5).
 *
 * Six sections, one per operational need, and nothing beyond them:
 *   Informasi Tempat — edit the canonical Place data.
 *   Publikasi        — the current status and whether it may be published.
 *   Pengelola        — the owner (if any) and the memberships on this Place.
 *   Klaim            — the claim history for THIS Place, read-only here:
 *                      the decision is made once, in /admin/places (Klaim
 *                      Tempat), and it never creates a second Place.
 *   Moderasi         — Terbitkan / Jeda / Arsipkan / Pulihkan dari arsip.
 *   Riwayat          — what the existing infrastructure can support: creation
 *                      and last-edit time, the claim timeline, and how much
 *                      data depends on this Place (no audit table is invented).
 *
 * The read is server-side and re-verifies Platform Admin authorization; a
 * non-moderator is stopped by the layout guard before this renders.
 */
export default async function AdminPlaceDetailPage({ params }: { params: Promise<{ placeId: string }> }) {
  const { placeId } = await params;

  let detail: Awaited<ReturnType<typeof getAdminPlaceDetail>>;
  try {
    detail = await getAdminPlaceDetail(placeId);
  } catch {
    return (
      <div className="space-y-8">
        <AdminPageHeader title="Tempat" description="Workspace Tempat." />
        <AdminErrorState message="Data Tempat tidak dapat dimuat." />
      </div>
    );
  }

  if (!detail) notFound();

  const { place, memberships, claims, producerName } = detail;
  const status = place.publicationStatus as PublicationStatus;
  const ready = isPlacePublicationReady(place);

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title={place.name}
        description={`${place.area} · ${place.category} · ${place.type} · ${place.id}`}
      />
      <Link href="/admin/places" className="inline-block text-xs font-bold text-black/55 hover:text-brand-accent">
        ← Kembali ke daftar Tempat
      </Link>

      <section aria-label="Informasi Tempat" className="rounded-2xl border border-black/10 bg-white p-5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-black/50">Informasi Tempat</h3>
        <p className="mt-1 mb-4 text-xs text-black/55">
          Data kanonik Tempat. Pengelola dan status publikasi tidak dapat diubah dari sini.
        </p>
        <AdminPlaceEditor place={place} />
      </section>

      <section aria-label="Publikasi" className="rounded-2xl border border-black/10 bg-white p-5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-black/50">Publikasi</h3>
        <dl className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Status</dt>
            <dd className="mt-1">
              <AdminStatusBadge
                value={publicationStatusLabel(status)}
                tone={status === "published" ? "positive" : status === "archived" ? "negative" : "warning"}
              />
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Kesiapan terbit</dt>
            <dd className="mt-1 text-sm text-black/70">{ready ? "Lengkap" : "Belum lengkap"}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Timezone</dt>
            <dd className="mt-1 text-sm text-black/70">{timezoneLabel(place.timezone)}</dd>
          </div>
        </dl>
      </section>

      <section aria-label="Pengelola" className="rounded-2xl border border-black/10 bg-white p-5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-black/50">Pengelola</h3>
        {place.producer ? (
          <p className="mt-2 text-sm text-black/75">
            <span className="font-bold">{producerName ?? place.producer.displayName}</span>{" "}
            <span className="font-mono text-xs text-black/50">{place.producer.id}</span>
          </p>
        ) : (
          <p className="mt-2 text-sm text-black/60">
            Tanpa Pengelola. Tempat ini bisa diklaim oleh pemilik sah, dan klaim ditinjau di{" "}
            <Link href="/admin/places" className="font-bold text-brand-primary underline underline-offset-2">
              daftar Tempat
            </Link>
            .
          </p>
        )}
        <ul className="mt-3 divide-y divide-black/5">
          {memberships.length === 0 ? (
            <li className="py-2 text-xs text-black/50">Belum ada membership.</li>
          ) : (
            memberships.map((membership) => (
              <li key={`${membership.userId}-${membership.producerId}`} className="flex flex-wrap justify-between gap-2 py-2 text-xs text-black/70">
                <span className="font-mono">{membership.userId.slice(0, 8)}…</span>
                <span>
                  {membership.role} · {formatAdminTimestamp(membership.createdAt)}
                </span>
              </li>
            ))
          )}
        </ul>
      </section>

      <section aria-label="Klaim" className="rounded-2xl border border-black/10 bg-white p-5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-black/50">Klaim</h3>
        <p className="mt-1 mb-3 text-xs text-black/55">
          Hanya persetujuan klaim yang memberi kepemilikan, dan persetujuan tidak pernah membuat Tempat baru.
        </p>
        {claims.length === 0 ? (
          <p className="text-sm text-black/60">Belum ada klaim untuk Tempat ini.</p>
        ) : (
          <ul className="divide-y divide-black/5">
            {claims.map((claim) => (
              <li key={claim.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <span className="font-mono text-black/60">pengaju {claim.userId.slice(0, 8)}…</span>
                <span className="text-black/60">{formatAdminTimestamp(claim.createdAt)}</span>
                <AdminStatusBadge
                  value={claim.status}
                  tone={claim.status === "approved" ? "positive" : claim.status === "rejected" ? "negative" : "warning"}
                />
                {claim.reviewNote ? <span className="w-full text-black/55">catatan: {claim.reviewNote}</span> : null}
              </li>
            ))}
          </ul>
        )}
        <Link href="/admin/places" className="mt-3 inline-block text-xs font-bold text-brand-primary underline underline-offset-2">
          Buka antrean review klaim
        </Link>
      </section>

      <section aria-label="Moderasi" className="rounded-2xl border border-black/10 bg-white p-5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-black/50">Moderasi</h3>
        <p className="mt-1 mb-3 text-xs text-black/55">
          Terbitkan, jeda, arsipkan, atau pulihkan dari arsip. Tempat tidak pernah dihapus permanen sebagai operasi
          Admin.
        </p>
        <AdminPlaceModeration placeId={place.id} status={status} />
      </section>

      <section aria-label="Riwayat" className="rounded-2xl border border-black/10 bg-white p-5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-black/50">Riwayat</h3>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Dibuat</dt>
            <dd className="mt-1 text-sm text-black/70">{formatAdminTimestamp(detail.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Diperbarui</dt>
            <dd className="mt-1 text-sm text-black/70">{formatAdminTimestamp(detail.updatedAt)}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Klaim</dt>
            <dd className="mt-1 text-sm text-black/70">{claims.length}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Data terkait</dt>
            <dd className="mt-1 text-sm text-black/70">
              {detail.experienceCount} Kegiatan · {detail.visitIntentCount} Kunjungan · {detail.liveSessionCount} Live
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
