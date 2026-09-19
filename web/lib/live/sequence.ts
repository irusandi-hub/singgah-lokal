import "server-only";

import { advanceSequence } from "@/lib/live/sequence-core";

/**
 * Server-time comment sequencing (tech §6): comments are ephemeral Realtime
 * broadcasts with no persisted table, so ordering comes from a server-issued
 * monotonic per-session sequence. Server-clock monotonicity beats
 * `Date.now()` collisions; across server restarts sequence equality may
 * occur and clients fall back to append-order.
 *
 * Rate limiting is separate (session-service.ts, TUNABLE ~1/5s per viewer).
 */
const sequences = new Map<string, number>();

export function nextLiveCommentSequence(sessionId: string): number {
  const previous = sequences.get(sessionId) ?? 0;
  const next = advanceSequence(previous, Date.now());
  sequences.set(sessionId, next);
  return next;
}

export function resetLiveCommentSequences(): void {
  sequences.clear();
}
