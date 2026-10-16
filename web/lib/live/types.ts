export type LiveSessionStatus = "scheduled" | "live" | "ended";

/**
 * Locked end reasons. `source_stage_unpublished` is LEGACY-ONLY: it is kept in
 * the vocabulary (and in the database CHECK constraint) because historical rows
 * already carry it and audit history must stay readable, but nothing in Live
 * produces it any more — Kelola Proses is informational and cannot end a Live
 * (product decision 2026-10-16). A new attempt to use it is refused by
 * `end_live_session` with `live_end_reason_invalid`.
 */
export type LiveSessionEndReason = "producer_ended" | "duration_cap" | "source_stage_unpublished" | "moderation";

export type LiveSession = {
  id: string;
  placeId: string;
  producerId: string;
  /**
   * Optional Process reference, informational only: Live is a Place-associated
   * capability and needs no Production Stage. Sessions created after
   * 2026-10-16 carry null; historical sessions keep the stage they recorded.
   * Never used for authorization, eligibility, gating, or lifecycle.
   */
  stageId: string | null;
  status: LiveSessionStatus;
  liveInputId: string | null;
  startedAt: string;
  endedAt: string | null;
  endedReason: LiveSessionEndReason | null;
  endNote: string | null;
  viewerPeak: number;
};

export type LiveEligibility = {
  producerId: string;
  path: "RATING" | "CURATED" | "EXCLUSIVE" | "HISTORY" | "ADMIN_APPROVED";
  active: boolean;
  ratingThreshold: number | null;
  minRatingCount: number | null;
  grantedBy: string | null;
  grantedAt: string;
};

export type LiveReportCategory =
  | "sexual_content"
  | "graphic_violence"
  | "illegal_activity"
  | "prohibited_product"
  | "smoking"
  | "unsafe_activity"
  | "minor_as_subject"
  | "private_data"
  | "other";

export type LiveReport = {
  id: string;
  liveSessionId: string;
  reporterId: string;
  category: LiveReportCategory;
  note: string | null;
  commentRef: string | null;
  createdAt: string;
};

export type LiveRealtimePayload =
  | { event: "status"; sessionId: string; status: LiveSessionStatus; endedReason: LiveSessionEndReason | null }
  | { event: "comment"; sessionId: string; sequence: number; body: string; authorId: string }
  | { event: "presence"; sessionId: string; viewerCount: number }
  | { event: "capacity_full"; sessionId: string };

export const LIVE_CONCURRENT_VIEWER_CAP = 100;
export const LIVE_GLOBAL_ACTIVE_CAP = 5;
export const LIVE_PER_PLACE_ACTIVE_CAP = 1;
export const LIVE_DURATION_CAP_MINUTES = 60;
export const LIVE_COMMENT_MAX_LENGTH = 300;
/**
 * TUNABLE (tech §6): ~1 comment / 5 s per viewer. The CANONICAL enforcement is
 * in the database (`post_live_comment` against the shared
 * `live_comment_rate_limits` store, migration 0054) so the window is identical
 * across server instances; this constant mirrors the same value for client
 * messaging and drift checks.
 */
export const LIVE_COMMENT_MIN_INTERVAL_MS = 5000;
/**
 * Viewer presence heartbeat interval (A-04, migration 0053). The server counts
 * a viewer as present while its presence lease is inside the TUNABLE grace
 * window (5 minutes, `admit_live_viewer` / `live_realtime_*`), so the client
 * must renew well inside that window to keep a watching viewer counted. A
 * closed tab stops renewing and drops out of the count after the grace window.
 */
export const LIVE_VIEWER_PRESENCE_INTERVAL_MS = 60_000;
export const LIVE_REPORT_NOTE_MAX_LENGTH = 500;
/** Tunable (tech §10, Phase 5): provider max is 24 h; we sign short. */
export const LIVE_PLAYBACK_TOKEN_TTL_SECONDS = 60;
