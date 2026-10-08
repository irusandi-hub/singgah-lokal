import PlaceWorkspace from "./PlaceWorkspace";

/**
 * The Place workspace deep link (/producer/places/[placeId]).
 *
 * It renders the SAME workspace component as the dashboard's in-place editor
 * and the production-story route, so every entry point shows one context, one
 * navigation layer and one work area. The workspace owns its own back link
 * ("← Pengelola" → the dashboard).
 */
export default async function EditPlacePage({ params }: { params: Promise<{ placeId: string }> }) {
  const { placeId } = await params;
  return <PlaceWorkspace placeId={placeId} />;
}
