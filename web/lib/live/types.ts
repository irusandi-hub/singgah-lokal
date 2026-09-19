export type LiveSessionStatus = "scheduled" | "live" | "ended";

export type LiveSessionEndReason = "producer_ended" | "duration_cap" | "source_stage_unpublished" | "moderation";

export type LiveSession = {
  id: string;
  placeId: string;
  producerId: string;
  stageId: string;
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
export const LIVE_COMMENT_MIN_INTERVAL_MS = 5000;
export const LIVE_REPORT_NOTE_MAX_LENGTH = 500;
