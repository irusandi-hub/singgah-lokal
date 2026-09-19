/**
 * Pure monotonic per-session sequence logic (tech §6) — kept free of
 * "server-only" so the unit test can import it directly. The server wrapper
 * lives in sequence.ts.
 */
export function advanceSequence(previous: number, now: number): number {
  return now > previous ? now : previous + 1
    ; // server-clock monotonicity; restarts may repeat, clients fall back to append-order
}

export function advanceSequenceFrom(
  previous: number,
  timeProvider: () => number,
): number {
  return advanceSequence(previous, timeProvider());
}
