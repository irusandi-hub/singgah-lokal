/**
 * DISPLAY FORMATTING.
 *
 * PRESENTATION ONLY. The stored values never change: a schedule date stays
 * "2026-04-01" and a Place timezone stays the IANA id "Asia/Jakarta". These
 * helpers only decide how those values READ in the Producer UI, because a raw
 * ISO date or a raw IANA id is a system value, not something a person reads.
 */

const MONTH_SHORT_ID = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
] as const;

/**
 * A Place-local calendar date, stored as "YYYY-MM-DD". It is already the
 * Place's own wall-clock date, so it is formatted as text — no timezone
 * conversion, which could shift the day.
 */
export function formatPlaceDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return date;
  const [, year, month, day] = match;
  const monthName = MONTH_SHORT_ID[Number(month) - 1];
  if (!monthName) return date;
  return `${Number(day)} ${monthName} ${year}`;
}

/**
 * The readable part of an IANA timezone id: "Asia/Jakarta" → "Jakarta",
 * "America/New_York" → "New York". Falls back to the value itself for an id
 * with no region prefix.
 */
export function timezoneLabel(timezone: string): string {
  const trimmed = timezone.trim();
  if (!trimmed) return trimmed;
  const city = trimmed.split("/").pop() ?? trimmed;
  return city.replace(/_/g, " ");
}
