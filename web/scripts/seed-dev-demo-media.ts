/**
 * DEV-ONLY DEMO MEDIA SEED (2026-10-05).
 *
 * ⚠ DEV ONLY — DO NOT RUN AGAINST PRODUCTION.
 *
 * PURPOSE
 * Populate the existing DEV demo Places with one cover image each so the Home
 * and Place detail surfaces render real image content instead of the local
 * placeholder. It is a DATA operation only:
 *
 * - the artwork is generated here (`lib/dev/demo-cover-art.ts`) and clearly
 *   labelled DEMO — it is never presented as a real Producer's photograph;
 * - objects are stored in the EXISTING `place-media` bucket, under the EXISTING
 *   `places/<placeId>/<slotKey>-<random>.<ext>` layout;
 * - the canonical reference is written to the EXISTING `place_photos` table
 *   under the standard `hook` slot, with title + description validated by the
 *   EXISTING media validators;
 * - `places.cover_image_url` (migration 0018) — the canonical field Home and
 *   Place detail already read — is pointed at that stored object. No image URL
 *   is invented or hardcoded anywhere in the app.
 *
 * It does NOT touch names, descriptions, categories, coordinates, publication
 * status, claims, discovery logic, or any non-demo Place. It creates no
 * feature: the same code path a Producer upload uses (`lib/place-media-storage`
 * + `place_photos` + `cover_image_url`) is what runs here, minus the Producer
 * authorization gate that demo Places intentionally have no membership for.
 *
 * USAGE
 *   npx tsx scripts/seed-dev-demo-media.ts            # dry run, prints the plan
 *   npx tsx scripts/seed-dev-demo-media.ts --apply    # performs the writes
 *   npx tsx scripts/seed-dev-demo-media.ts --apply --force
 *   npx tsx scripts/seed-dev-demo-media.ts --apply --force --only=sari-tempe-makmur
 *
 * The script is idempotent: a Place that already has its canonical `hook`
 * reference AND a resolvable `cover_image_url` is skipped, so re-running never
 * duplicates rows or objects. `--force` re-renders the artwork (a DEV refresh)
 * and `--only=<id,id>` narrows it to specific demo Places; both stay inside the
 * demo set and never touch non-demo data.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import {
  PLACE_MEDIA_BUCKET,
  PLACE_MEDIA_MAX_BYTES,
  isPlacePhotoSlotKey,
  validatePlaceMediaFile,
  validatePlacePhotoMeta,
} from "@/lib/place-media";
import { buildDemoCoverSvg, resolveDemoMotif, type DemoMotif } from "@/lib/dev/demo-cover-art";

/** Canonical DEV demo seeds (0019 + the 0001 fixtures) that carry no dummy flag. */
const DEV_SEED_PLACE_IDS = [
  "bakso-migran",
  "dapur-rasa",
  "kopi-dari-kebun",
  "rumah-teh-lokal",
] as const;

/** Bulk DEV fixtures created outside a migration (dummy-<city>-<nn>). */
const BULK_DUMMY_ID_PATTERN = /^dummy-[a-z]+-\d+$/;

/** The one slot the demo seed fills: the first standard slot (0021 contract). */
const DEMO_SLOT_KEY = "hook";

type PlaceRow = {
  id: string;
  name: string;
  short_description: string | null;
  category: string | null;
  area: string | null;
  type: string | null;
  is_dummy: boolean | null;
  cover_image_url: string | null;
};

type PhotoRow = { place_id: string; slot_key: string; storage_path: string };

/** DEV demo Places only — everything else is refused, never guessed. */
export function isDemoPlace(place: Pick<PlaceRow, "id" | "is_dummy" | "short_description">): boolean {
  if (place.is_dummy === true) return true;
  if ((DEV_SEED_PLACE_IDS as readonly string[]).includes(place.id)) return true;
  if (BULK_DUMMY_ID_PATTERN.test(place.id)) return true;
  const description = (place.short_description ?? "").toLowerCase();
  return description.startsWith("demo place") || description.startsWith("dummy place");
}

/** The production storage layout, reproduced exactly (place-media-storage.ts). */
function buildStoragePath(placeId: string, slotKey: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(placeId)) throw new Error("place_input_invalid");
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `places/${placeId}/${slotKey}-${suffix}.png`;
}

function publicUrlFor(storagePath: string, base: string): string {
  return `${base}/storage/v1/object/public/${PLACE_MEDIA_BUCKET}/${storagePath}`;
}

type ServiceClient = SupabaseClient;

/** Does the referenced object really exist in the bucket? */
async function storedObjectExists(supabase: ServiceClient, storagePath: string): Promise<boolean> {
  const { error } = await supabase.storage.from(PLACE_MEDIA_BUCKET).download(storagePath);
  return !error;
}

async function renderDemoPng(place: PlaceRow): Promise<{ buffer: Buffer; motif: DemoMotif }> {
  const motif = resolveDemoMotif(place);
  const svg = buildDemoCoverSvg({
    name: place.name,
    motif,
    area: place.area,
    kindLabel: place.type === "experience" ? "Demo Place" : "Demo Place • Produksi",
  });
  const buffer = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  return { buffer, motif };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const onlyArg = process.argv.find((argument) => argument.startsWith("--only="));
  const onlyIds = onlyArg ? onlyArg.slice("--only=".length).split(",").filter(Boolean) : null;
  if (process.env.NODE_ENV === "production") {
    throw new Error("dev_demo_media_seed_refused_in_production");
  }

  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) throw new Error("supabase_service_configuration_missing");
  const supabase = createClient(baseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: places, error: placesError } = await supabase
    .from("places")
    .select("id, name, short_description, category, area, type, is_dummy, cover_image_url")
    .order("id");
  if (placesError) throw placesError;

  const demoPlaces = (places ?? []).filter(isDemoPlace);
  const skippedNonDemo = (places ?? []).filter((place) => !isDemoPlace(place)).map((place) => place.id);
  console.log(
    `mode=${apply ? "APPLY" : "DRY RUN"}${force ? "+FORCE" : ""} | demo places=${demoPlaces.length} | non-demo (never touched)=${skippedNonDemo.length}`,
  );
  if (skippedNonDemo.length) console.log(`non-demo ids: ${skippedNonDemo.join(", ")}`);

  const { data: photos, error: photosError } = await supabase
    .from("place_photos")
    .select("place_id, slot_key, storage_path");
  if (photosError) throw photosError;
  const hookRows = new Map(
    (photos ?? [])
      .filter((row) => row.slot_key === DEMO_SLOT_KEY && isPlacePhotoSlotKey(row.slot_key))
      .map((row) => [row.place_id, row as PhotoRow]),
  );
  const legacyRows = (photos ?? []).filter((row) => row.slot_key !== DEMO_SLOT_KEY);

  let created = 0;
  let skipped = 0;
  let repaired = 0;
  let failed = 0;

  for (const place of demoPlaces) {
    if (onlyIds && !onlyIds.includes(place.id)) continue;
    const hook = hookRows.get(place.id);
    if (hook && place.cover_image_url && !force) {
      skipped += 1;
      continue;
    }

    const { buffer, motif } = await renderDemoPng(place);
    // The EXISTING production validators gate the file and the metadata.
    validatePlaceMediaFile({ type: "image/png", size: buffer.byteLength });
    const meta = validatePlacePhotoMeta(
      `Demo cover — ${place.name}`,
      `Ilustrasi demo untuk Discovery DEV (motif: ${motif}). Bukan foto Producer dan bukan bukti kepemilikan.`,
    );
    if (buffer.byteLength > PLACE_MEDIA_MAX_BYTES) throw new Error("place_photo_size_invalid");

    const storagePath = buildStoragePath(place.id, DEMO_SLOT_KEY);
    const url = publicUrlFor(storagePath, baseUrl);
    console.log(
      `${apply ? "seed" : "plan "} ${place.id} | motif=${motif} | png=${Math.round(buffer.byteLength / 1024)}kB | ${storagePath}`,
    );
    if (!apply) {
      created += 1;
      continue;
    }

    const { error: uploadError } = await supabase.storage
      .from(PLACE_MEDIA_BUCKET)
      .upload(storagePath, buffer, {
        contentType: "image/png",
        cacheControl: "31536000",
        upsert: false,
      });
    if (uploadError) {
      console.error(`  upload failed for ${place.id}: ${uploadError.message}`);
      failed += 1;
      continue;
    }

    if (hook) {
      // An existing `hook` row is only rewritten when its object is genuinely
      // missing, or when a DEV refresh explicitly asked for it. A slot whose
      // object still exists is Producer-owned media and is otherwise left
      // exactly as it is — this seed never overwrites real uploads.
      if (force || !(await storedObjectExists(supabase, hook.storage_path))) {
        const { error } = await supabase
          .from("place_photos")
          .update({ storage_path: storagePath, title: meta.title, description: meta.description })
          .eq("place_id", place.id)
          .eq("slot_key", DEMO_SLOT_KEY);
        if (error) throw error;
      }
    } else {
      const { error } = await supabase.from("place_photos").insert({
        place_id: place.id,
        slot_key: DEMO_SLOT_KEY,
        storage_path: storagePath,
        title: meta.title,
        description: meta.description,
        sort_order: 0,
      });
      if (error) throw error;
    }

    // A reference whose stored OBJECT is missing is dangling — an earlier
    // manual attempt wrote rows for objects it never uploaded. Those are
    // repointed at the object just stored, so no reference is left dangling.
    // A row whose object still EXISTS (a real Producer upload) is NEVER
    // touched: this seed adds demo media, it never overwrites it.
    for (const legacy of legacyRows.filter((row) => row.place_id === place.id)) {
      if (await storedObjectExists(supabase, legacy.storage_path)) continue;
      const { error } = await supabase
        .from("place_photos")
        .update({ storage_path: storagePath })
        .eq("place_id", place.id)
        .eq("slot_key", legacy.slot_key);
      if (error) throw error;
      repaired += 1;
      console.log(`  repaired dangling reference ${place.id}/${legacy.slot_key}`);
    }

    const { error: coverError } = await supabase
      .from("places")
      .update({ cover_image_url: url })
      .eq("id", place.id);
    if (coverError) throw coverError;
    created += 1;
  }

  console.log(
    `summary: ${apply ? "applied" : "planned"}=${created} skipped=${skipped} repaired=${repaired} failed=${failed}`,
  );
}

main().catch((error) => {
  console.error("FAILED", error instanceof Error ? error.message : String(error));
  process.exit(1);
});