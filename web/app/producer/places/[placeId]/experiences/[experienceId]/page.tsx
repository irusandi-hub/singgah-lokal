import Link from "next/link";
import { PageHeader, PageShell, Panel, backLinkClass } from "@/components/ui/kit";
import { ExperienceEditor } from "../ExperienceForm";

export default async function EditExperiencePage({ params }: { params: Promise<{ placeId: string; experienceId: string }> }) {
  const { placeId, experienceId } = await params;
  return (
    <PageShell width="narrow">
      <PageHeader
        back={
          <Link className={backLinkClass} href={`/producer/places/${placeId}/experiences`}>
            ← Kembali ke Kegiatan
          </Link>
        }
        title="Edit Kegiatan"
      />
      <div className="mt-4">
        <Panel>
          <ExperienceEditor placeId={placeId} experienceId={experienceId} />
        </Panel>
      </div>
    </PageShell>
  );
}
