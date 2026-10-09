import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminErrorState, AdminPageHeader, AdminStatusBadge, formatAdminTimestamp } from "@/components/admin/ui";
import AdminPlaceEditor from "@/components/admin/place-editor";
import AdminPlaceModeration from "@/components/admin/place-moderation";
import AdminPlaceCuration from "@/components/admin/place-curation";
import { getAdminPlaceDetail, getAdminPlaceDiscoveryView } from "@/lib/admin/place-workspace";
import { formatDiscoveryStars, DISCOVERY_BREAKDOWN_LABELS } from "@/lib/admin/discovery-view";
import { listPlaceAudit, type PlaceAuditRow } from "@/lib/admin/place-audit";
import { PLACE_AUDIT_ACTION_LABEL, placeAuditChanges } from "@/lib/place-audit-format";
import { listAdminActorEmails } from "@/lib/admin/user-directory";
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
 *   Live             — this Place's Live sessions and Live reports, READ-ONLY.
 *                      Live belongs to the Place it happens in, so it is read
 *                      here alongside the Place's own data. Nothing on this
 *                      surface starts, ends, or moderates a Live session: the
 *                      existing Producer and RPC-gated Live flows are untouched.
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

  const { place, memberships, claims, producerName, liveSessions, liveReports } = detail;
  const status = place.publicationStatus as PublicationStatus;
  const ready = isPlacePublicationReady(place);

  // Riwayat (MASTER 09 §2/§13): the append-only trail of Admin action on this
  // Place. Read through the service role behind the same moderator guard that
  // produced the rest of this page, and only here — the table is revoked from
  // `public`, `anon` and `authenticated`, so no Producer, User, or public
  // surface can reach it. If migration 0031 has not been applied yet the
  // workspace still renders and says so, rather than failing the whole page.
  let audit: PlaceAuditRow[] = [];
  let auditAvailable = true;
  let actorEmails = new Map<string, string>();
  try {
    audit = await listPlaceAudit(placeId);
    actorEmails = await listAdminActorEmails(audit.map((entry) => entry.actorId));
  } catch {
    auditAvailable = false;
  }

  // Stage 4: the canonical engine's current evaluation of this Place —
  // READ-ONLY (stars + rank + breakdown; the numeric score never leaves the
  // server). A degraded engine read must never break the workspace.
  const discoveryView = await getAdminPlaceDiscoveryView(placeId).catch(() => undefined);

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title={place.name}
        description={`${place.area} · ${place.category} · ${place.type} · ${place.id}`}
      />
      <Link
        href="/admin/places"
        className="inline-flex items-center gap-1 text-xs font-bold text-brand-primary underline underline-offset-2 hover:text-brand-primary-deep"
      >
        <span aria-hidden>←</span> Kembali ke daftar Tempat
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

      {/* Stage 4: Discovery visibility (READ-ONLY) + the Tempat Pilihan
          decision. One section keeps the layered relationship explicit:
          Discovery is computed by the engine and cannot be set; Tempat
          Pilihan is the only Admin decision here, and it never changes
          publication, claim, ownership, or any Discovery value. */}
      <section aria-label="Discovery dan Tempat Pilihan" className="rounded-2xl border border-black/10 bg-white p-5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-black/50">Discovery & Tempat Pilihan</h3>
        <div className="mt-3 grid gap-5 lg:grid-cols-2">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Discovery Place</p>
            {discoveryView ? (
              <>
                <p className="mt-1 text-2xl font-bold tracking-tight text-brand-primary" aria-label={`Discovery ${discoveryView.stars} bintang`}>
                  {formatDiscoveryStars(discoveryView.stars)}
                </p>
                <p className="mt-1 text-xs text-black/55">
                  {discoveryView.eligible
                    ? discoveryView.rank !== null
                      ? `Peringkat #${discoveryView.rank} di Discovery — dihitung sistem dari data kanonik.`
                      : "Eligible — peringkat mengikuti perhitungan platform."
                    : "Belum eligible — lengkapi data kanonik Tempat."}
                </p>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {DISCOVERY_BREAKDOWN_LABELS.map(({ key, label }) => {
                    const value = discoveryView.breakdown[key as keyof typeof discoveryView.breakdown] ?? 0;
                    return (
                      <div key={key} className="flex items-center justify-between gap-2">
                        <dt className="text-xs text-black/55">{label}</dt>
                        <dd className="text-xs font-bold text-black/75">{value}</dd>
                      </div>
                    );
                  })}
                </dl>
                <p className="mt-2 text-[11px] text-black/40">
                  Breakdown bersifat baca-saja. Nilai berasal dari canonical Discovery engine.
                </p>
              </>
            ) : (
              <p className="mt-1 text-xs text-black/55">
                Penilaian Discovery belum tersedia untuk Tempat ini.
              </p>
            )}
          </div>
          <div className="lg:border-l lg:border-black/10 lg:pl-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Tempat Pilihan</p>
            <div className="mt-2">
              <AdminPlaceCuration placeId={place.id} isCurated={place.isCurated} />
            </div>
          </div>
        </div>
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

      <section aria-label="Live" className="rounded-2xl border border-black/10 bg-white p-5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-black/50">Live</h3>
        <p className="mt-1 mb-3 text-xs text-black/55">
          Data Live milik Tempat ini, dibaca saja. Mulai, akhiri, dan moderasi Live tetap mengikuti alur Producer
          yang sudah ada.
        </p>

        <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Sesi Live</h4>
        {liveSessions.length === 0 ? (
          <p className="mt-1 text-sm text-black/60">Belum ada Sesi Live untuk Tempat ini.</p>
        ) : (
          <ul className="mt-1 divide-y divide-black/5">
            {liveSessions.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs text-black/70">
                <span className="font-mono">{session.id}</span>
                <AdminStatusBadge
                  value={session.status}
                  tone={session.status === "live" ? "live" : session.endedReason === "moderation" ? "negative" : "neutral"}
                />
                <span>mulai {formatAdminTimestamp(session.startedAt)}</span>
                <span className="text-black/50">
                  selesai {session.endedAt ? formatAdminTimestamp(session.endedAt) : "—"}
                  {session.endedReason ? ` · ${session.endedReason}` : ""}
                </span>
                <span className="text-black/50">proses (tahap) {session.stageId}</span>
                <span className="text-black/50">puncak {session.viewerPeak}</span>
              </li>
            ))}
          </ul>
        )}

        <h4 className="mt-4 text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Laporan Live</h4>
        {liveReports.length === 0 ? (
          <p className="mt-1 text-sm text-black/60">Belum ada Laporan Live untuk Tempat ini.</p>
        ) : (
          <ul className="mt-1 divide-y divide-black/5">
            {liveReports.map((report) => (
              <li key={report.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs text-black/70">
                <span className="font-mono">{report.id}</span>
                <AdminStatusBadge value={report.category} tone={report.category === "other" ? "neutral" : "warning"} />
                <span className="text-black/50">{formatAdminTimestamp(report.createdAt)}</span>
                {report.note ? <span className="w-full text-black/55">{report.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
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

        <h4 className="mt-5 text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">
          Jejak tindakan Admin
        </h4>
        <p className="mt-1 text-xs leading-5 text-black/55">
          Setiap tindakan Admin terhadap Tempat ini tercatat permanen dan tidak dapat diubah atau dihapus.
        </p>
        {!auditAvailable ? (
          <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-800" role="status">
            Riwayat tindakan belum tersedia. Terapkan migration 0031 (place_audit) di Supabase SQL Editor.
          </p>
        ) : audit.length === 0 ? (
          <p className="mt-3 text-sm text-black/60">Belum ada tindakan Admin yang tercatat.</p>
        ) : (
          <ol className="mt-3 divide-y divide-black/5">
            {audit.map((entry) => {
              const changes = placeAuditChanges(entry.before, entry.after);
              const reviewNote = typeof entry.detail.reviewNote === "string" ? entry.detail.reviewNote : null;
              return (
                <li key={entry.id} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-bold text-black/80">
                      {PLACE_AUDIT_ACTION_LABEL[entry.action] ?? entry.action}
                    </span>
                    <span className="text-xs text-black/50">{formatAdminTimestamp(entry.createdAt)}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-black/55">
                    oleh {actorEmails.get(entry.actorId) ?? `admin ${entry.actorId.slice(0, 8)}…`}
                  </p>
                  {changes.length > 0 ? (
                    <ul className="mt-1.5 space-y-0.5">
                      {changes.map((change) => (
                        <li key={change.field} className="text-xs text-black/65">
                          <span className="font-semibold">{change.label}</span>: {change.from} → {change.to}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {reviewNote ? <p className="mt-1 text-xs italic text-black/55">catatan: {reviewNote}</p> : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
