/**
 * AGE FROM DATE OF BIRTH — computed on the SERVER, never stored as a number.
 *
 * A stored age would go stale; only the date of birth is persisted and the age
 * is derived on every read (`calculateAge`). All pure functions so the same
 * computation is used by the API and by tests.
 *
 * POLICY GAP: no Master defines a minimum ACCOUNT age. MASTER_LIVE_POLICY
 * §12.1 item 3 defines an 18+ LIVE VIEWER gate whose mechanism is deferred to
 * Phase 2.1, and it states explicitly that a self-declared date of birth does
 * NOT satisfy that gate — so nothing here grants eligibility, and there is no
 * `MIN_ACCOUNT_AGE_YEARS` constant to invent. Only the sanity bounds below are
 * applied (not in the future, not more than 120 years back).
 *
 * POLICY GAP: the reference timezone for age is undefined. One constant,
 * `ACCOUNT_AGE_TIMEZONE`, is the documented reference for the whole product;
 * it never depends on the client, and it is NOT the Place schedule timezone
 * rule (that one is locked per Place and unrelated to a user's age).
 */

export const ACCOUNT_AGE_TIMEZONE = "Asia/Jakarta";

/** Sanity bound only — not a policy minimum age. */
export const MAX_ACCOUNT_AGE_YEARS = 120;

export type DateOfBirthError =
  | "date_of_birth_invalid"
  | "date_of_birth_future"
  | "date_of_birth_too_old";

type CalendarDate = { year: number; month: number; day: number };

const DATE_OF_BIRTH_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function calendarDateInTimeZone(at: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: read("year"), month: read("month"), day: read("day") };
}

/**
 * Strict `YYYY-MM-DD` parse. A calendar-impossible date (e.g. `2026-02-30`) and
 * a non-date string both fail — there is no lenient rollover.
 */
export function parseDateOfBirth(
  value: unknown,
): { ok: true; value: string; date: CalendarDate } | { ok: false; error: DateOfBirthError } {
  if (typeof value !== "string") return { ok: false, error: "date_of_birth_invalid" };
  const match = DATE_OF_BIRTH_PATTERN.exec(value.trim());
  if (!match) return { ok: false, error: "date_of_birth_invalid" };

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, error: "date_of_birth_invalid" };
  }

  // Round-trip through UTC catches impossible days (Feb 30, Apr 31, Feb 29 in
  // a non-leap year) without any timezone involvement.
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return { ok: false, error: "date_of_birth_invalid" };
  }

  return {
    ok: true,
    value: `${match[1]}-${match[2]}-${match[3]}`,
    date: { year, month, day },
  };
}

/**
 * Age in whole years at `at`, using the product's reference timezone.
 *
 * A Feb-29 date of birth therefore turns a year older on Mar 1 in non-leap
 * years: on 2026-02-28 the (month, day) pair `(2, 28)` still precedes
 * `(2, 29)`, and on 2026-03-01 it does not.
 */
export function calculateAge(
  dateOfBirth: string,
  at: Date = new Date(),
  timeZone: string = ACCOUNT_AGE_TIMEZONE,
): number | null {
  const parsed = parseDateOfBirth(dateOfBirth);
  if (!parsed.ok) return null;

  const today = calendarDateInTimeZone(at, timeZone);
  let age = today.year - parsed.date.year;
  const beforeBirthday =
    today.month < parsed.date.month ||
    (today.month === parsed.date.month && today.day < parsed.date.day);
  if (beforeBirthday) age -= 1;

  return age < 0 ? null : age;
}

/** Sanity validation only — see the Policy Gaps in this file's header. */
export function validateDateOfBirth(
  value: unknown,
  at: Date = new Date(),
  timeZone: string = ACCOUNT_AGE_TIMEZONE,
): DateOfBirthError | null {
  const parsed = parseDateOfBirth(value);
  if (!parsed.ok) return parsed.error;

  const today = calendarDateInTimeZone(at, timeZone);
  const isFuture =
    parsed.date.year > today.year ||
    (parsed.date.year === today.year && parsed.date.month > today.month) ||
    (parsed.date.year === today.year &&
      parsed.date.month === today.month &&
      parsed.date.day > today.day);
  if (isFuture) return "date_of_birth_future";

  const age = calculateAge(parsed.value, at, timeZone);
  if (age === null || age > MAX_ACCOUNT_AGE_YEARS) return "date_of_birth_too_old";

  return null;
}
