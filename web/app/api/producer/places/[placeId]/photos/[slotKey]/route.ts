import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getPlacePhotoSlot, PlaceMediaError, validatePlaceMediaFile, validatePlacePhotoMeta } from "@/lib/place-media";
import { mapPlacePhotoRow, removePlacePhotoObject, uploadPlacePhoto } from "@/lib/place-media-storage";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * PLACE MEDIA UPLOAD — one standard slot of a Place (PO request, 2026-09-25).
 *
 * POST /api/producer/places/[placeId]/photos/[slotKey]
 *   multipart/form-data: file + title + description
 *
 * Server-side, fail-closed:
 * - the session must hold a producer_membership for the Place
 *   (owner/manager/editor — the Place-management write surface);
 * - file type + size are validated server-side (lib/place-media limits);
 * - title + description are required (Production Story content structure);
 * - the file goes to Supabase Storage via the SERVICE-ROLE client; the saved
 *   reference (slot key, storage path, title, description) lands in
 *   `place_photos` (0021) keyed by (place_id, slot_key) — so a reload
 *   restores every slot from the canonical record.
 * - REPLACE is idempotent: the previous object is deleted after the new
 *   reference is saved, so a repeated submit never duplicates a slot.
 */
export async function POST(request: Request, { params }: { params: Promise<{ placeId: string; slotKey: string }> }) {
  try {
    const { placeId, slotKey } = await params;
    const slot = getPlacePhotoSlot(slotKey);
    await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new PlaceMediaError("place_photo_file_required");
    validatePlaceMediaFile({ type: file.type, size: file.size });
    const meta = validatePlacePhotoMeta(form.get("title"), form.get("description"));

    const supabase = createSupabaseServiceClient();

    const previous = await supabase
      .from("place_photos")
      .select("id, place_id, slot_key, storage_path, title, description, sort_order")
      .eq("place_id", placeId)
      .eq("slot_key", slot.key)
      .maybeSingle<{ id: string; place_id: string; slot_key: string; storage_path: string; title: string; description: string; sort_order: number }>();
    if (previous.error) throw new Error("place_media_unavailable");

    const uploaded = await uploadPlacePhoto({ placeId, slotKey: slot.key, file });

    const saved = previous.data
      ? await supabase
          .from("place_photos")
          .update({
            storage_path: uploaded.storagePath,
            title: meta.title,
            description: meta.description,
            updated_at: new Date().toISOString(),
          })
          .eq("id", previous.data.id)
          .select("id, place_id, slot_key, storage_path, title, description, sort_order")
          .single()
      : await supabase
          .from("place_photos")
          .insert({
            place_id: placeId,
            slot_key: slot.key,
            storage_path: uploaded.storagePath,
            title: meta.title,
            description: meta.description,
            sort_order: slot.sortOrder,
          })
          .select("id, place_id, slot_key, storage_path, title, description, sort_order")
          .single();
    if (saved.error || !saved.data) throw new Error("place_media_upload_failed");

    // The reference is canonical now — the replaced object can go.
    if (previous.data) await removePlacePhotoObject(previous.data.storage_path);

    return NextResponse.json(mapPlacePhotoRow(saved.data as never));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    if (error instanceof PlaceMediaError) return NextResponse.json({ error: error.code }, { status: 400 });
    if (error instanceof Error && error.message === "place_media_bucket_missing") {
      return NextResponse.json({ error: "place_media_bucket_missing" }, { status: 503 });
    }
    return NextResponse.json({ error: "place_media_upload_failed" }, { status: 400 });
  }
}

/** DELETE — remove a slot's photo + reference (Producer-managed surface). */
export async function DELETE(request: Request, { params }: { params: Promise<{ placeId: string; slotKey: string }> }) {
  try {
    const { placeId, slotKey } = await params;
    const slot = getPlacePhotoSlot(slotKey);
    await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);

    const supabase = createSupabaseServiceClient();
    const existing = await supabase
      .from("place_photos")
      .select("id, storage_path")
      .eq("place_id", placeId)
      .eq("slot_key", slot.key)
      .maybeSingle<{ id: string; storage_path: string }>();
    if (existing.error) throw new Error("place_media_unavailable");
    if (!existing.data) return NextResponse.json({ ok: true });

    const removed = await supabase.from("place_photos").delete().eq("id", existing.data.id);
    if (removed.error) throw new Error("place_media_upload_failed");
    await removePlacePhotoObject(existing.data.storage_path);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    return NextResponse.json({ error: "place_media_upload_failed" }, { status: 400 });
  }
}
