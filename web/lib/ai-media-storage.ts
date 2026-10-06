import "server-only";

import { type AiMediaOutputKey, type AiMediaSourceKey } from "@/lib/ai-media";
import { PLACE_MEDIA_BUCKET } from "@/lib/place-media";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * AI MEDIA STORAGE — Supabase Storage access for AI source + output media.
 *
 * PRIVATE buckets (see migration 0042): `ai-media-sources` (the Producer's 4
 * source photos) and `ai-media-outputs` (the 2 generated draft outputs). No
 * storage.objects policy exists for either bucket, so anon/authenticated have
 * ZERO direct access — every read/write here runs through the service-role
 * client AFTER the API layer verified the session's Producer access.
 *
 * Only an APPROVED output is PROMOTED, by server code, into the public
 * `place-media` bucket so its https URL can be referenced by the Place
 * (hook → places.cover_image_url; place_story → the story asset). Drafts are
 * never public.
 *
 * Object layout:
 *   sources/<placeId>/<source>-<random>.<ext>
 *   outputs/<placeId>/<output>-<random>.<ext>
 *   (promoted) ai-outputs/<placeId>/<output>-<random>.<ext>   [place-media]
 */

export const AI_MEDIA_SOURCE_BUCKET = "ai-media-sources";
export const AI_MEDIA_OUTPUT_BUCKET = "ai-media-outputs";

const PLACE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUFFIX_BYTES = 12;

type AiMediaBucket = typeof AI_MEDIA_SOURCE_BUCKET | typeof AI_MEDIA_OUTPUT_BUCKET;

function assertPlaceId(placeId: string): string {
  if (!PLACE_ID_PATTERN.test(placeId)) throw new Error("ai_media_input_invalid");
  return placeId;
}

function randomSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extensionFor(fileName: string, mimeType: string): string {
  const guess = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
  const ext = guess.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  if (ext) return ext;
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/avif") return "avif";
  throw new Error("ai_media_source_type_invalid");
}

/** Public URL for an object that lives in a PUBLIC bucket (place-media only). */
function publicUrlFor(bucket: string, storagePath: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("ai_media_config_missing");
  return `${base}/storage/v1/object/public/${bucket}/${storagePath}`;
}

async function uploadObject(bucket: AiMediaBucket, storagePath: string, file: File): Promise<void> {
  const { error } = await createSupabaseServiceClient()
    .storage.from(bucket)
    .upload(storagePath, file, {
      contentType: file.type,
      cacheControl: "31536000",
      upsert: false,
    });
  if (error) {
    if (error.message === "Bucket not found") throw new Error("ai_media_bucket_missing");
    throw new Error("ai_media_upload_failed");
  }
}

/** Upload one PRIVATE AI source photo. Returns only the storage reference. */
export async function uploadAiMediaSource(params: {
  placeId: string;
  sourceKey: AiMediaSourceKey;
  file: File;
}): Promise<{ storagePath: string; bucket: AiMediaBucket }> {
  const placeId = assertPlaceId(params.placeId);
  const ext = extensionFor(params.file.name ?? "", params.file.type);
  const storagePath = `sources/${placeId}/${params.sourceKey}-${randomSuffix()}.${ext}`;
  await uploadObject(AI_MEDIA_SOURCE_BUCKET, storagePath, params.file);
  return { storagePath, bucket: AI_MEDIA_SOURCE_BUCKET };
}

/** Upload one PRIVATE generated output (draft). Returns the storage reference. */
export async function uploadAiMediaOutput(params: {
  placeId: string;
  outputKey: AiMediaOutputKey;
  file: File;
}): Promise<{ storagePath: string; bucket: AiMediaBucket }> {
  const placeId = assertPlaceId(params.placeId);
  const ext = extensionFor(params.file.name ?? "", params.file.type);
  const storagePath = `outputs/${placeId}/${params.outputKey}-${randomSuffix()}.${ext}`;
  await uploadObject(AI_MEDIA_OUTPUT_BUCKET, storagePath, params.file);
  return { storagePath, bucket: AI_MEDIA_OUTPUT_BUCKET };
}

/** Best-effort delete of a private object. Failure never blocks canonical state. */
export async function removeAiMediaObject(bucket: string, storagePath: string): Promise<void> {
  await createSupabaseServiceClient()
    .storage.from(bucket)
    .remove([storagePath])
    .catch(() => {});
}

/**
 * Best-effort delete of a promoted (public) object from `place-media`. Used to
 * reconcile a promotion whose approval RPC then failed.
 */
export async function removePromotedAiMediaObject(publicPath: string): Promise<void> {
  await removeAiMediaObject(PLACE_MEDIA_BUCKET, publicPath);
}

/** Remove every stored AI source object for a Place (cleanup path). */
export async function removeAiMediaSourceObjects(placeId: string): Promise<void> {
  await removeAllInFolder(AI_MEDIA_SOURCE_BUCKET, `sources/${assertPlaceId(placeId)}`);
}

/** Remove every stored AI output object for a Place (cleanup path). */
export async function removeAiMediaOutputObjects(placeId: string): Promise<void> {
  await removeAllInFolder(AI_MEDIA_OUTPUT_BUCKET, `outputs/${assertPlaceId(placeId)}`);
}

async function removeAllInFolder(bucket: string, folder: string): Promise<void> {
  const svc = createSupabaseServiceClient();
  const { data, error } = await svc.storage.from(bucket).list(folder, { limit: 1000 });
  if (error || !data?.length) return;
  await svc.storage.from(bucket).remove(data.map((object) => `${folder}/${object.name}`));
}

/**
 * Mint a short-lived signed read URL for a PRIVATE object (sources or drafts).
 * This is the only way source media is ever read; it is minted server-side
 * after the Producer gate.
 */
export async function getSignedAiMediaUrl(bucket: string, storagePath: string): Promise<string> {
  const { data, error } = await createSupabaseServiceClient()
    .storage.from(bucket)
    .createSignedUrl(storagePath, 300);
  if (error || !data?.signedUrl) throw new Error("ai_media_source_read_failed");
  return data.signedUrl;
}

/**
 * PROMOTION: copy an APPROVED private output into the public `place-media`
 * bucket and return its https URL. Called only from the approval route, for
 * owner/manager approvals. Drafts are never promoted.
 */
export async function promoteAiMediaOutputToPublic(params: {
  placeId: string;
  outputKey: AiMediaOutputKey;
  storagePath: string;
  mimeType: string;
}): Promise<{ publicUrl: string; publicPath: string }> {
  const placeId = assertPlaceId(params.placeId);
  const ext = extensionFor(params.storagePath, params.mimeType);
  const publicPath = `ai-outputs/${placeId}/${params.outputKey}-${randomSuffix()}.${ext}`;
  const { error } = await createSupabaseServiceClient()
    .storage.from(AI_MEDIA_OUTPUT_BUCKET)
    .copy(params.storagePath, publicPath, { destinationBucket: PLACE_MEDIA_BUCKET });
  if (error) throw new Error("ai_media_promotion_failed");
  return { publicUrl: publicUrlFor(PLACE_MEDIA_BUCKET, publicPath), publicPath };
}


