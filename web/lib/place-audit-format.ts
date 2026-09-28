import type { Place } from "@/lib/places";

/**
 * PLACE AUDIT — presentation layer (vocabulary, snapshot, diff).
 *
 * Split from lib/admin/place-audit.ts, which is `server-only` because it
 * touches the service-role client. Everything here is pure and data-shaped,
 * following the same separation the repo already uses for lib/status-labels.ts
 * and lib/display-format.ts: the canonical VALUES live in the audit module and
 * the database, and this file only names and formats them.
 *
 * The stored values are the canonical action keys and the canonical Place
 * column names — nothing here invents or renames a status.
 */

export const PLACE_AUDIT_ACTIONS = {
  created: "admin_place_created",
  updated: "admin_place_updated",
  published: "admin_place_published",
  paused: "admin_place_paused",
  archived: "admin_place_archived",
  restored: "admin_place_restored",
  claimApproved: "place_claim_approved",
  claimRejected: "place_claim_rejected",
} as const;

export type PlaceAuditAction = (typeof PLACE_AUDIT_ACTIONS)[keyof typeof PLACE_AUDIT_ACTIONS];

/** Operator-facing Indonesian label per action, for the Riwayat surface. */
export const PLACE_AUDIT_ACTION_LABEL: Record<PlaceAuditAction, string> = {
  admin_place_created: "Place dibuat",
  admin_place_updated: "Data Place diubah",
  admin_place_published: "Place diterbitkan",
  admin_place_paused: "Place dijeda",
  admin_place_archived: "Place diarsipkan",
  admin_place_restored: "Place dipulihkan dari arsip",
  place_claim_approved: "Klaim disetujui",
  place_claim_rejected: "Klaim ditolak",
};

/** Canonical Place columns, in a stable order, as stored in the audit row. */
const SNAPSHOT_FIELDS = [
  "name",
  "short_description",
  "category",
  "type",
  "area",
  "address",
  "contact_information",
  "timezone",
  "currency",
  "latitude",
  "longitude",
  "cover_image_url",
  "producer_id",
  "claim_status",
  "publication_status",
] as const;

export type PlaceAuditSnapshot = Record<string, unknown>;

/**
 * Snapshot of the canonical Place columns. `producer_id` / `claim_status` /
 * `publication_status` are included on purpose: a claim approval and a status
 * change are the decisions an audit trail exists to explain, even though the
 * read path never writes them directly.
 *
 * The snapshot is built from the Place type alone, so it structurally cannot
 * carry a user email, a credential, or any infrastructure value.
 */
export function placeAuditSnapshot(place: Place): PlaceAuditSnapshot {
  return {
    name: place.name,
    short_description: place.shortDescription,
    category: place.category,
    type: place.type,
    area: place.area,
    address: place.address,
    contact_information: place.contactInformation,
    timezone: place.timezone,
    currency: place.currency,
    latitude: place.latitude,
    longitude: place.longitude,
    cover_image_url: place.coverImageUrl,
    producer_id: place.producer?.id ?? null,
    claim_status: place.claimStatus,
    publication_status: place.publicationStatus,
  };
}

const FIELD_LABEL: Record<string, string> = {
  name: "Nama",
  short_description: "Deskripsi singkat",
  category: "Kategori",
  type: "Tipe",
  area: "Area",
  address: "Alamat",
  contact_information: "Kontak",
  timezone: "Timezone",
  currency: "Currency",
  latitude: "Latitude",
  longitude: "Longitude",
  cover_image_url: "Cover image",
  producer_id: "Pengelola",
  claim_status: "Status klaim",
  publication_status: "Status publikasi",
};

/** Bounded so a long address can never blow up the Riwayat row. */
function auditValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const text = String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * The fields that actually changed between two snapshots, in the canonical
 * order. Computed at render time from the stored snapshots rather than stored
 * again, so the displayed diff can never drift from the canonical data.
 */
export function placeAuditChanges(
  before: PlaceAuditSnapshot | null,
  after: PlaceAuditSnapshot | null,
): Array<{ field: string; label: string; from: string; to: string }> {
  if (!before) return [];
  return SNAPSHOT_FIELDS.filter(
    (field) => String(before[field] ?? "") !== String(after?.[field] ?? ""),
  ).map((field) => ({
    field,
    label: FIELD_LABEL[field] ?? field,
    from: auditValue(before[field]),
    to: auditValue(after?.[field]),
  }));
}
