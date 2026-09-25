import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { PLACE_PHOTO_SLOTS } from "@/lib/place-media";
import { mapPlacePhotoRow } from "@/lib/place-media-storage";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * GET /api/producer/places/[placeId]/photos
 *
 * Returns every standard slot for the Place with its saved reference (if
 * any). The Producer form restores all slots from this canonical record on
 * load/reload — nothing lives only in the browser.
 */
export async function GET(request: Request, { params }: { params: Promise<{ placeId: string }> }) {
  try {
    const { placeId } = await params;
    await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);

    const supabase = createSupabaseServiceClient();
    const { data, error } = await supabase
      .from("place_photos")
      .select("id, place_id, slot_key, storage_path, title, description, sort_order")
      .eq("place_id", placeId);
    if (error) throw new Error("place_media_unavailable");

    const bySlot = new Map((data ?? []).map((row) => [String(row.slot_key), row]));

    return NextResponse.json({
      slots: PLACE_PHOTO_SLOTS.map((slot) => {
        const row = bySlot.get(slot.key);
        if (!row) return { slotKey: slot.key, filled: false, photo: null };
        const photo = mapPlacePhotoRow(row as never);
        return {
          slotKey: slot.key,
          filled: true,
          photo: {
            id: photo.id,
            url: photo.url,
            storagePath: photo.storagePath,
            title: photo.title,
            description: photo.description,
          },
        };
      }),
    });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    return NextResponse.json({ error: "place_media_unavailable" }, { status: 400 });
  }
}
