import { AdminBackToAdminCenter, AdminErrorState, AdminPageHeader } from "@/components/admin/ui";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";
import ClaimArchiveSearch, { ARCHIVE_SEARCH_KEYS } from "./ClaimArchiveSearch";
import ClaimArchiveResults from "./ClaimArchiveResults";
import { searchPlaceClaimArchives, type PlaceClaimArchiveRow } from "@/lib/admin/place-claim-archive";

export const dynamic = "force-dynamic";

/**
 * RIWAYAT & ARSIP — the internal claim-archive search (MASTER §5/§16.1).
 *
 * The one Admin surface where the archive may be looked up, by ONE key at a
 * time: Place ID, Pengelola ID, Email, or Claim ID. The search itself runs in
 * this server component against the existing `search_place_claim_archives`
 * RPC through lib/admin/place-claim-archive — no new data path, no new
 * authorization logic: the layout guard stops non-moderators before this
 * renders, and the RPC re-verifies the moderator role inside the database on
 * every call.
 *
 * MASTER §4 boundary: this page shows the archive as a deliberate search
 * surface, not as normal history — no operational page renders archive rows,
 * and results carry claim METADATA only. Evidence file contents are never
 * displayed, minted, or linked from here (only the file name is shown).
 * Finalized/expired rows are outside the RPC's 30-day window by design.
 */
export default async function AdminClaimArchivePage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string; q?: string }>;
}) {
  const params = await searchParams;
  const requestedKey = typeof params.key === "string" ? params.key : "";
  const searchKey = (ARCHIVE_SEARCH_KEYS as readonly string[]).includes(requestedKey)
    ? (requestedKey as (typeof ARCHIVE_SEARCH_KEYS)[number])
    : "placeId";
  const query = typeof params.q === "string" ? params.q.trim() : "";

  let results: PlaceClaimArchiveRow[] | null = null;
  let failed = false;
  if (query) {
    try {
      results = await searchPlaceClaimArchives({ [searchKey]: query });
    } catch (error) {
      if (error instanceof PlatformModeratorRequiredError) throw error;
      failed = true;
    }
  }

  return (
    <div className="space-y-8">
      <AdminBackToAdminCenter />
      <AdminPageHeader
        title="Riwayat & Arsip"
        description="Pencarian internal arsip klaim Tempat untuk kebutuhan operasional/audit. Arsip disimpan 30 hari sejak pengarsipan; baris yang sudah difinalisasi tidak lagi dapat dicari. Hanya metadata klaim yang ditampilkan — isi file bukti tidak pernah ditampilkan di sini."
      />

      <ClaimArchiveSearch searchKey={searchKey} />

      {failed ? (
        <AdminErrorState message="Arsip tidak dapat dimuat. Tidak ada data yang ditampilkan agar tidak menyesatkan." />
      ) : null}

      {results !== null && !failed ? <ClaimArchiveResults results={results} searchKey={searchKey} query={query} /> : null}
    </div>
  );
}
