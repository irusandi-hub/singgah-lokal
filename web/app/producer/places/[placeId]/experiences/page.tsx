import PlaceWorkspace from "../PlaceWorkspace";

/**
 * KEGIATAN for ONE Place — the SAME Place workspace, opened on the "Kegiatan"
 * item. The list itself is the shared ExperiencesPanel the workspace renders,
 * so this route adds no second list and no second "Tambah Kegiatan" action.
 */
export default async function ProducerExperiencesPage({ params }: { params: Promise<{ placeId: string }> }) {
  const { placeId } = await params;
  return <PlaceWorkspace placeId={placeId} initialTab="experience" />;
}
