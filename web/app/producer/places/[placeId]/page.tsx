import Link from "next/link";
import ProducerSubNav from "@/components/producer-sub-nav";
import { PageHeader, PageShell, backLinkClass, btn } from "@/components/ui/kit";
import { PlaceEditor } from "../PlaceForm";

/**
 * The Place workspace deep link — the same working surface as the dashboard's
 * in-place editor, reached by URL.
 *
 * ONE way back (the dashboard), ONE local navigation layer (ProducerSubNav),
 * ONE work area (PlaceEditor: Informasi | Kegiatan | Media). "Kelola Proses"
 * is the single entry into the production-story surface; Kegiatan is already a
 * tab of the editor, so no second button duplicates it.
 */
export default async function EditPlacePage({ params }: { params: Promise<{ placeId: string }> }) {
  const { placeId: id } = await params;
  return (
    <PageShell>
      <PageHeader
        back={
          <Link className={backLinkClass} href="/producer">
            ← Dashboard Pengelola
          </Link>
        }
        title="Kelola Tempat"
        description="Informasi, Kegiatan, dan Media Tempat ini dalam satu tempat."
        actions={
          <Link className={btn.solid} href={`/producer/places/${id}/production`}>
            Kelola Proses
          </Link>
        }
      />

      <div className="mt-4">
        <ProducerSubNav active="/producer/places" />
      </div>

      <div className="mt-4">
        <PlaceEditor id={id} />
      </div>
    </PageShell>
  );
}
