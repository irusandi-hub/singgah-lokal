import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getPlacePhotoSlot, PlaceMediaError, resolvePlaceCoverSync, validatePlaceMediaFile, validatePlacePhotoMeta } from "@/lib/place-media";
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
 * - HOOK ⇄ COVER (audit fix, 2026-10-05): the `hook` slot is ALSO the Place's
 *   public cover, so a Hook upload points `places.cover_image_url` at the
 *   uploaded object and a Hook delete clears it. Without this the upload
 *   succeeded but stayed invisible on Home, which renders `coverImageUrl`.
 *   The four other slots never touch the cover. The rule itself lives in
 *   `resolvePlaceCoverSync` (lib/place-media.ts), so exactly one place decides
 *   when the cover may change.
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

    // Write the canonical slot reference first (replace or insert).
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
    if (saved.error || !saved.data) {
      // The Storage object is live but the canonical reference failed. The
      // failure-safe contract is: no DB reference may outlive its object, so
      // the new object goes and the PREVIOUS object (untouched) stays
      // canonical. Nothing half-saved remains behind.
      await removePlacePhotoObject(uploaded.storagePath).catch(() => {});
      throw new Error("place_media_upload_failed");
    }

    // Hook ⇄ cover: the Place's public cover points at the stored object, so a
    // Hook upload (new or replacement) is what Home renders. Non-Hook slots
    // resolve to `null` here and therefore cannot touch the cover at all.
    const coverSync = resolvePlaceCoverSync({ slotKey: slot.key, action: "save", url: uploaded.url });
    if (coverSync) {
      const cover = await supabase.from("places").update(coverSync).eq("id", placeId);
      if (cover.error) {
        // The slot reference is saved but the cover did not update. Reporting
        // success here is exactly the bug this guards: the Place would show a
        // stale cover while the producer believed the new one was live. So the
        // new state is reconciled away and the REAL failure is surfaced.
        //
        // A replacement restores the previous reference (the Place keeps the
        // working photo it already had); a brand-new slot removes the row it
        // just wrote. Either way no half-saved slot survives, and the previous
        // Storage object was never deleted, so the restore is complete.
        if (previous.data) {
          const restored = await supabase
            .from("place_photos")
            .update({
              storage_path: previous.data.storage_path,
              title: previous.data.title,
              description: previous.data.description,
              updated_at: new Date().toISOString(),
            })
            .eq("id", previous.data.id)
            .select("id")
            .single();
          if (restored.error) {
            console.error("place_media_reference_rollback_failed", String(placeId), String(previous.data.id), restored.error.message);
          }
        } else {
          const removed = await supabase.from("place_photos").delete().eq("id", saved.data.id);
          if (removed.error) {
            console.error("place_media_reference_cleanup_failed", String(placeId), String(saved.data.id), removed.error.message);
          }
        }
        await removePlacePhotoObject(uploaded.storagePath).catch(() => {});
        throw new Error("place_media_upload_failed");
      }
    }

    // LAST MUTATION. The reference AND the cover are both canonical now, so the
    // replaced object can go. Doing this any earlier could destroy a working
    // photo before its replacement was confirmed — the original defect this
    // endpoint is being fixed for.
    if (previous.data && previous.data.storage_path !== uploaded.storagePath) {
      await removePlacePhotoObject(previous.data.storage_path).catch(() => {});
    }

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

    // Hook ⇄ cover: with its reference gone the Place has no cover any more.
    // Every other slot resolves to `null` and leaves the cover untouched.
    const coverSync = resolvePlaceCoverSync({ slotKey: slot.key, action: "delete" });
    if (coverSync) {
      const cover = await supabase.from("places").update(coverSync).eq("id", placeId);
      if (cover.error) throw new Error("place_media_upload_failed");
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    return NextResponse.json({ error: "place_media_upload_failed" }, { status: 400 });
  }
}
