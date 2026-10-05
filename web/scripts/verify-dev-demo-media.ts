import { createClient } from "@supabase/supabase-js";

/**
 * DEV-ONLY verification of the demo-media seed (2026-10-05).
 *
 * Proves, against the real DEV project, that:
 *  1. every demo Place has a canonical media reference (`place_photos` row);
 *  2. every `cover_image_url` RESOLVES through the public storage path;
 *  3. the stored objects are real images (content-type + non-trivial size);
 *  4. no non-demo Place was touched;
 *  5. pre-existing Producer uploads still point at their own stored objects.
 *
 * Read-only: it writes nothing.
 */

/**
 * Producer-owned references this check GUARDS rather than expects to exist.
 *
 * The seed adds the `hook` cover for every demo Place, so a demo Place's hook
 * row is demo media, not a Producer upload — those are covered by check 1/2
 * above. This list therefore holds only NON-hook slots that were uploaded
 * through the real Producer flow; the seed must never touch or drop them, and
 * they must keep resolving from their own stored objects.
 *
 * `bakso-migran/hook` and `bakso-migran/process` are deliberately absent: the
 * bakso hook is demo media, and its `process` slot has no surviving reference
 * (an earlier manual attempt wrote a row for an object it never stored — the
 * seed's dangling-reference repair removed exactly that).
 */
const PRODUCER_OWNED: Array<{ place_id: string; slot_key: string; storage_path: string }> = [
  { place_id: "rumah-teh-lokal", slot_key: "process", storage_path: "places/rumah-teh-lokal/process-6a27b61870950d9a594da19b.png" },
  { place_id: "rumah-teh-lokal", slot_key: "place", storage_path: "places/rumah-teh-lokal/place-a2a366220e49c4e3c5a67774.png" },
  { place_id: "rumah-teh-lokal", slot_key: "people", storage_path: "places/rumah-teh-lokal/people-100e31752a483fc5a0b6d009.png" },
  { place_id: "rumah-teh-lokal", slot_key: "product", storage_path: "places/rumah-teh-lokal/product-098c1f087bdc220aafb0a6b0.png" },
];

const BUCKET = "place-media";

function isDemoPlace(place: { id: string; is_dummy: boolean | null; short_description: string | null }): boolean {
  if (place.is_dummy === true) return true;
  if (["bakso-migran", "dapur-rasa", "kopi-dari-kebun", "rumah-teh-lokal"].includes(place.id)) return true;
  if (/^dummy-[a-z]+-\d+$/.test(place.id)) return true;
  const description = (place.short_description ?? "").toLowerCase();
  return description.startsWith("demo place") || description.startsWith("dummy place");
}

async function head(url: string): Promise<{ status: number; type: string | null; bytes: number }> {
  const response = await fetch(url, { method: "GET" });
  const buffer = response.ok ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    bytes: buffer.byteLength,
  };
}

async function main(): Promise<void> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
  const supabase = createClient(base, process.env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const problems: string[] = [];

  const { data: places } = await supabase
    .from("places")
    .select("id, name, is_dummy, short_description, cover_image_url, publication_status")
    .order("id");
  const { data: photos } = await supabase.from("place_photos").select("place_id, slot_key, storage_path, title");

  const demo = (places ?? []).filter(isDemoPlace);
  const nonDemo = (places ?? []).filter((place) => !isDemoPlace(place));
  console.log(`places total=${(places ?? []).length} demo=${demo.length} non-demo=${nonDemo.length}`);

  // 1 + 2 + 3: every demo Place has a cover that resolves to a real image.
  let resolved = 0;
  for (const place of demo) {
    const cover = place.cover_image_url;
    if (!cover) {
      problems.push(`${place.id}: cover_image_url is null`);
      continue;
    }
    const reference = (photos ?? []).find((row) => row.place_id === place.id && row.slot_key === "hook");
    if (!reference) problems.push(`${place.id}: no canonical hook reference in place_photos`);
    const result = await head(cover);
    if (result.status !== 200 || !result.type?.startsWith("image/") || result.bytes < 5000) {
      problems.push(`${place.id}: cover did not resolve (${result.status} ${result.type} ${result.bytes}b)`);
      continue;
    }
    resolved += 1;
  }
  console.log(`covers resolved over HTTP: ${resolved}/${demo.length}`);

  // 4: nothing outside the demo set exists/touched.
  for (const place of nonDemo) {
    if (place.cover_image_url) problems.push(`${place.id}: NON-DEMO place has a cover`);
  }

  // 5: Producer-owned uploads still resolve from their own references.
  for (const owned of PRODUCER_OWNED) {
    const row = (photos ?? []).find(
      (candidate) => candidate.place_id === owned.place_id && candidate.slot_key === owned.slot_key,
    );
    if (!row) {
      problems.push(`${owned.place_id}/${owned.slot_key}: producer reference row missing`);
      continue;
    }
    if (row.storage_path !== owned.storage_path) {
      problems.push(`${owned.place_id}/${owned.slot_key}: reference moved to ${row.storage_path}`);
      continue;
    }
    const url = `${base}/storage/v1/object/public/${BUCKET}/${row.storage_path}`;
    const result = await head(url);
    if (result.status !== 200) problems.push(`${owned.place_id}/${owned.slot_key}: object missing (${result.status})`);
  }

  // Dangling references: every row's object must resolve.
  let dangling = 0;
  for (const row of photos ?? []) {
    const url = `${base}/storage/v1/object/public/${BUCKET}/${row.storage_path}`;
    const result = await head(url);
    if (result.status !== 200) {
      dangling += 1;
      problems.push(`dangling reference ${row.place_id}/${row.slot_key} -> ${row.storage_path}`);
    }
  }
  console.log(`place_photos rows=${(photos ?? []).length} dangling=${dangling}`);

  console.log(problems.length === 0 ? "VERIFIED: all demo media resolves, nothing dangling" : problems.join("\n"));
  if (problems.length) process.exit(1);
}

main().catch((error) => {
  console.error("FAILED", error instanceof Error ? error.message : String(error));
  process.exit(1);
});