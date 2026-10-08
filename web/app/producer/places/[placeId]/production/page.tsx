import PlaceWorkspace from "../PlaceWorkspace";

/**
 * DARI SINI / "Kelola Proses" — the SAME Place workspace, opened on its fourth
 * item. The production story is a workspace state of the Place, not a separate
 * navigation layer, so this route adds no shell of its own: it starts the one
 * workspace on the production item and keeps the canonical deep link working.
 */
export default async function ProductionStoryPage({ params }: { params: Promise<{ placeId: string }> }) {
  const { placeId } = await params;
  return <PlaceWorkspace placeId={placeId} initialTab="production" />;
}
