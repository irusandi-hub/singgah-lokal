/**
 * AI PLACE MEDIA — locked contract module (SINGGAH LOKAL).
 *
 * Inputs (source photos): place, material, process, result
 * Outputs (generated): hook, place_story
 * Source limits: 5 MB, accepted image/jpeg|image/png|image/webp|image/avif
 * Regeneration: initially LOCKED (server gate only, no client bypass)
 *
 * Rules honored:
 *  - Original 4 photos remain unchanged. Generated media is DERIVED media,
 *    persisted separately from the canonical photo slots.
 *  - AI must not invent factual Place information: outputs are draft until
 *    Producer approval, and the canonical cover (places.cover_image_url) is
 *    updated only by approve_ai_media_output.
 *  - Never auto-publish AI output.
 *  - Generation is Producer-account bound (membership-gated RPCs).
 *  - Quota/cost controls are represented in the schema + this module.
 *  - Provider abstraction: provider is a stored enum/config, not a hardcoded
 *    vendor. No provider is invoked by this module.
 *  - "Generate Ulang" exists in the architecture but is LOCKED.
 *  - Regeneration generates BOTH outputs (hook + place_story) when unlocked.
 *  - Source media is never public; signed read only via server RPC.
 */

export const AI_MEDIA_SOURCE_KEYS = ["place", "material", "process", "result"] as const;
export const AI_MEDIA_OUTPUT_KEYS = ["hook", "place_story"] as const;

export type AiMediaSourceKey = (typeof AI_MEDIA_SOURCE_KEYS)[number];
export type AiMediaOutputKey = (typeof AI_MEDIA_OUTPUT_KEYS)[number];

export const AI_MEDIA_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const AI_MEDIA_ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;

export type AiMediaStatus = "draft" | "approved" | "rejected";
export type AiMediaGenerationJobStatus = "pending" | "queued" | "running" | "done" | "failed" | "locked";

/** Locked source-key label + prompt metadata for the Producer UI. */
export type AiMediaSourceSlot = {
  key: AiMediaSourceKey;
  label: string;
  promptHint: string;
  sortOrder: number;
};

/** Locked output-key label + intent metadata for the Producer UI. */
export type AiMediaOutputSlot = {
  key: AiMediaOutputKey;
  label: string;
  description: string;
  aspect: "portrait" | "landscape";
  sortOrder: number;
};

/**
 * The 4 source slots feed generation but are NOT the canonical Place cover or
 * the canonical photo slots. They are private source material for the Producer.
 */
export const AI_MEDIA_SOURCE_SLOTS: readonly AiMediaSourceSlot[] = [
  {
    key: "place",
    label: "Tempat",
    promptHint: "Tempat utama tempat ini.",
    sortOrder: 0,
  },
  {
    key: "material",
    label: "Bahan",
    promptHint: "Bahan baku/utama yang dipakai.",
    sortOrder: 1,
  },
  {
    key: "process",
    label: "Proses Produksi",
    promptHint: "Proses produksi di tempat ini.",
    sortOrder: 2,
  },
  {
    key: "result",
    label: "Hasil",
    promptHint: "Hasil produksi akhirnya.",
    sortOrder: 3,
  },
] as const;

/**
 * The 2 generated outputs.
 *
 * - hook: canonical Place cover (portrait). Updates cover_image_url ONLY after
 *   Producer approval via approve_ai_media_output.
 * - place_story: horizontal/landscape story image for Home/Discovery cards that
 *   communicates Tempat → Bahan → Proses → Hasil and is grounded in the 4
 *   source photos (NOT a simple 4-panel collage).
 */
export const AI_MEDIA_OUTPUT_SLOTS: readonly AiMediaOutputSlot[] = [
  {
    key: "hook",
    label: "Hook Image",
    description: "Sampul Place canonical yang diturunkan dari 4 foto sumber.",
    aspect: "portrait",
    sortOrder: 0,
  },
  {
    key: "place_story",
    label: "Place Story Image",
    description: "Gambar cerita horizontal untuk Home/Discovery yang menghubungkan Tempat → Bahan → Proses → Hasil, berakar pada 4 foto sumber.",
    aspect: "landscape",
    sortOrder: 1,
  },
] as const;

/** Client-facing error codes the UI maps to readable messages. */
export type AiMediaErrorCode =
  | "ai_media_source_key_invalid"
  | "ai_media_source_type_invalid"
  | "ai_media_source_size_invalid"
  | "ai_media_output_key_invalid"
  | "ai_media_output_type_invalid"
  | "ai_media_output_size_invalid"
  | "ai_media_status_invalid"
  | "ai_media_output_not_found"
  | "ai_media_output_not_draft"
  | "ai_media_output_public_url_invalid"
  | "ai_media_idempotency_key_invalid"
  | "ai_media_regeneration_locked"
  | "ai_media_quota_exhausted"
  | "ai_media_quota_invalid"
  | "ai_media_prompt_key_invalid"
  | "ai_media_prompt_version_invalid"
  | "ai_media_generation_locked"
  | "ai_media_source_upload_failed"
  | "ai_media_output_upload_failed"
  | "ai_media_bucket_missing"
  | "ai_media_unavailable"
  | "producer_authorization_required";

export class AiMediaError extends Error {
  readonly code: AiMediaErrorCode;
  constructor(code: AiMediaErrorCode) {
    super(code);
    this.code = code;
  }
}

/**
 * Append-only audit vocabulary for AI media actions.
 *
 * This is the code-side mirror of the CHECK constraint on
 * `public.ai_media_audit` (migration 0043). Every action that touches AI media
 * — a source upload, a server-worker output save, an approve/reject decision, a
 * regeneration attempt (allowed or blocked), or a fail-closed quota refusal —
 * is recorded with the authenticated Producer account that performed it, so the
 * history is attributable and never rewritten.
 */
export const AI_MEDIA_AUDIT_ACTIONS = {
  sourceUploaded: "ai_source_uploaded",
  sourceRemoved: "ai_source_removed",
  outputSaved: "ai_output_saved",
  outputApproved: "ai_output_approved",
  outputRejected: "ai_output_rejected",
  regenerationRequested: "ai_regeneration_requested",
  regenerationBlocked: "ai_regeneration_blocked",
  generationQuotaBlocked: "ai_generation_quota_blocked",
} as const;

export type AiMediaAuditAction = (typeof AI_MEDIA_AUDIT_ACTIONS)[keyof typeof AI_MEDIA_AUDIT_ACTIONS];

/** What an audit row is about, when it targets a specific AI media object. */
export const AI_MEDIA_AUDIT_TARGET_TYPES = ["source", "output", "job", "quota"] as const;
export type AiMediaAuditTargetType = (typeof AI_MEDIA_AUDIT_TARGET_TYPES)[number];

export function validateAiMediaAuditAction(action: unknown): action is AiMediaAuditAction {
  if (typeof action !== "string") return false;
  return (Object.values(AI_MEDIA_AUDIT_ACTIONS) as readonly string[]).includes(action);
}

export function validateAiMediaAuditTargetType(target: unknown): target is AiMediaAuditTargetType {
  if (typeof target !== "string") return false;
  return (AI_MEDIA_AUDIT_TARGET_TYPES as readonly string[]).includes(target);
}

/** File-type + size gate for AI source photos (server-side; mirrored client-side). */
export function validateAiMediaSourceFile(file: { type?: unknown; size?: unknown }): void {
  if (typeof file.type !== "string" || !(AI_MEDIA_ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
    throw new AiMediaError("ai_media_source_type_invalid");
  }
  if (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size <= 0 || file.size > AI_MEDIA_MAX_BYTES) {
    throw new AiMediaError("ai_media_source_size_invalid");
  }
}

/** Source key validation. */
export function validateAiMediaSourceKey(key: unknown): key is AiMediaSourceKey {
  if (typeof key !== "string") return false;
  return (AI_MEDIA_SOURCE_KEYS as readonly string[]).includes(key);
}

/** Output key validation. */
export function validateAiMediaOutputKey(key: unknown): key is AiMediaOutputKey {
  if (typeof key !== "string") return false;
  return (AI_MEDIA_OUTPUT_KEYS as readonly string[]).includes(key);
}

/** Status validation. */
export function validateAiMediaStatus(status: unknown): status is AiMediaStatus {
  if (typeof status !== "string") return false;
  return (["draft", "approved", "rejected"] as readonly string[]).includes(status);
}

/** Generation job status validation. */
export function validateAiMediaGenerationJobStatus(status: unknown): status is AiMediaGenerationJobStatus {
  if (typeof status !== "string") return false;
  return (["pending", "queued", "running", "done", "failed", "locked"] as readonly string[]).includes(status);
}

/** Provider abstraction: the provider is a stored string/config, not hardcoded. */
export type AiMediaProviderConfig = {
  provider: string;
  providerFeatures: string[];
  enabled: boolean;
};

/**
 * Generative provider interface. This module does NOT call a provider. When a
 * real provider integration is explicitly available/approved, the server job
 * worker implements this and obtains stored output URLs to persist via
 * save_ai_media_output.
 */
export interface AiMediaProvider {
  readonly providerName: string;
  /** Both outputs must be generated for a regeneration job. */
  generateBoth(
    placeId: string,
    producerId: string,
    sources: Readonly<Record<AiMediaSourceKey, { storagePath: string; mimeType: string }>>,
  ): Promise<{ hook: { storagePath: string; mimeType: string; byteSize: number }; placeStory: { storagePath: string; mimeType: string; byteSize: number } }>;
}

/** Which outputs a regeneration job must produce when eventually unlocked. */
export const REGENERATION_OUTPUT_KEYS: readonly AiMediaOutputKey[] = ["hook", "place_story"];

/**
 * REGENERATION LOCK — LOCKED initially (locked product design).
 *
 * "Generate Ulang" is architecturally supported (the `regenerate_ai_media` RPC,
 * the job table and the both-outputs contract) but this constant is the
 * single code-side switch and it starts `false`. Flipping it is a product
 * decision in server code, never a client one: no request parameter, header or
 * cookie can change it.
 */
export const PLACE_AI_REGENERATE_UNLOCKED = false;

/**
 * Whether regeneration is unlocked server-side. This is the single gate; the
 * client may not bypass it by any parameter/header/cookie. When false, every
 * regeneration attempt is refused.
 */
export function isAiMediaRegenerationUnlocked(): boolean {
  // Locked by default (PLACE_AI_REGENERATE_UNLOCKED === false). The server job
  // worker / admin config flips this when the feature is approved. This module
  // never invents an unlocked state.
  return PLACE_AI_REGENERATE_UNLOCKED;
}

/** Canonical DB row for one generated output (server-side shape). */
export type AiMediaOutputRow = {
  id: string;
  place_id: string;
  producer_id: string;
  output_key: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  status: string;
  provider: string | null;
  generated_at: string;
  approved_at: string | null;
  approved_by: string | null;
  approved_public_url: string | null;
};

export type AiMediaOutput = {
  id: string;
  placeId: string;
  producerId: string;
  outputKey: AiMediaOutputKey;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  status: AiMediaStatus;
  provider: string | null;
  generatedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  /** Public https URL, set only by approval of an approved output. */
  approvedPublicUrl: string | null;
};

/** Map a canonical DB row to a typed output (never sent raw to anon clients). */
export function mapAiMediaOutputRow(row: AiMediaOutputRow): AiMediaOutput {
  return {
    id: String(row.id),
    placeId: String(row.place_id),
    producerId: String(row.producer_id),
    outputKey: String(row.output_key) as AiMediaOutputKey,
    storagePath: String(row.storage_path),
    mimeType: String(row.mime_type),
    byteSize: Number(row.byte_size),
    status: String(row.status) as AiMediaStatus,
    provider: row.provider ? String(row.provider) : null,
    generatedAt: String(row.generated_at),
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvedPublicUrl: row.approved_public_url ? String(row.approved_public_url) : null,
  };
}

/** Idempotency key validation for generation jobs. */
export function validateAiMediaIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || !key.trim() || key.trim().length > 200) {
    throw new AiMediaError("ai_media_idempotency_key_invalid");
  }
  return key.trim();
}

// ---------------------------------------------------------------------------
// Prompt / version tracking + request metadata (migration 0044)
//
// Provider-neutral: this records WHICH prompt revision a run used and the
// request context around it, so a generated image is reproducible and
// explainable. It names no vendor and performs no generation.
// ---------------------------------------------------------------------------

/** The prompt revision keys, one per output. Code is the source of truth. */
export const AI_MEDIA_PROMPT_KEYS = {
  hook: "place_hook_image",
  placeStory: "place_story_image",
} as const;

export type AiMediaPromptKey = (typeof AI_MEDIA_PROMPT_KEYS)[keyof typeof AI_MEDIA_PROMPT_KEYS];

/** The prompt revision that produced an output maps 1:1 to its output key. */
export const AI_MEDIA_PROMPT_KEYS_BY_OUTPUT: Record<AiMediaOutputKey, AiMediaPromptKey> = {
  hook: AI_MEDIA_PROMPT_KEYS.hook,
  place_story: AI_MEDIA_PROMPT_KEYS.placeStory,
};

/**
 * Current prompt revision. It is bumped in code when a prompt changes; the
 * database stores the value as a bounded positive integer so history is never
 * rewritten by a later revision.
 */
export const AI_MEDIA_CURRENT_PROMPT_VERSION = 1;

/** Which kind of run produced (or requested) an output. */
export const AI_MEDIA_GENERATION_KINDS = ["initial", "regeneration"] as const;
export type AiMediaGenerationKind = (typeof AI_MEDIA_GENERATION_KINDS)[number];

/** Bound prompt key validation (mirrors the 0044 CHECK). */
export function validateAiMediaPromptKey(key: unknown): key is string {
  return typeof key === "string" && key.trim().length > 0 && key.length <= 80;
}

/** A prompt version is a positive integer (mirrors the 0044 CHECK). */
export function validateAiMediaPromptVersion(version: unknown): version is number {
  return typeof version === "number" && Number.isInteger(version) && version > 0;
}

/**
 * Build the persisted request metadata for a generation run. Pure and
 * provider-neutral: it names the outputs, their prompt keys, the prompt
 * revision and the request moment — nothing about a vendor and no Place facts
 * that could be invented.
 */
export function buildAiMediaRequestMetadata(params: {
  generationKind: AiMediaGenerationKind;
  outputKeys: readonly AiMediaOutputKey[];
  promptVersion: number;
  requestedAt: string;
}): Record<string, unknown> {
  if (!validateAiMediaPromptVersion(params.promptVersion)) {
    throw new AiMediaError("ai_media_prompt_version_invalid");
  }
  return {
    generationKind: params.generationKind,
    outputKeys: [...params.outputKeys],
    promptKeys: params.outputKeys.map((key) => AI_MEDIA_PROMPT_KEYS_BY_OUTPUT[key]),
    promptVersion: params.promptVersion,
    requestedAt: params.requestedAt,
  };
}
