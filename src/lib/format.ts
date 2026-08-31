/**
 * Date and time formatting for the India-facing UI.
 *
 * Every absolute time is rendered in IST and labelled as such: a score page that
 * shows a bare time is ambiguous, and the audience for /india/* is Indian. The
 * timezone is pinned explicitly rather than left to the runtime so the server
 * output is deterministic and identical to what a client would produce.
 *
 * These helpers never substitute a placeholder date. Missing input returns null
 * so callers can omit the row instead of inventing one.
 */

const LOCALE = "en-IN";
const TIME_ZONE = "Asia/Kolkata";

/** Shown next to times so "7:30 pm" is never ambiguous. */
export const TIME_ZONE_LABEL = "IST";

const dayMonth = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
});

const dayMonthYear = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
});

const timeOfDay = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** Calendar year in IST, which can differ from the UTC year late at night. */
const year = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  year: "numeric",
});

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** Machine-readable value for a `<time dateTime>` attribute. */
export function toIsoAttribute(date: Date): string {
  return date.toISOString();
}

/** "31 Aug 2026" */
export function formatDay(date: Date): string {
  return dayMonthYear.format(date);
}

/** "7:30 pm IST" */
export function formatTime(date: Date): string {
  return `${timeOfDay.format(date)} ${TIME_ZONE_LABEL}`;
}

/** "31 Aug 2026, 7:30 pm IST" */
export function formatDayTime(date: Date): string {
  return `${dayMonthYear.format(date)}, ${formatTime(date)}`;
}

/**
 * A tournament window, collapsed as far as the two dates allow:
 * "27 Aug – 2 Sep 2026", "27 Aug 2026" for a single day, and an open-ended
 * "From …" / "Until …" when only one end is known. Null when neither is.
 */
export function formatDateRange(
  start: Date | null,
  end: Date | null,
): string | null {
  if (start === null) {
    return end === null ? null : `Until ${formatDay(end)}`;
  }
  if (end === null) return `From ${formatDay(start)}`;
  if (formatDay(start) === formatDay(end)) return formatDay(start);
  // Drop the repeated year from the left side: "27 Aug – 2 Sep 2026".
  return year.format(start) === year.format(end)
    ? `${dayMonth.format(start)} – ${formatDay(end)}`
    : `${formatDay(start)} – ${formatDay(end)}`;
}

/**
 * "5 minutes ago", "in 3 hours", "yesterday". Coarse on purpose: freshness only
 * needs to answer "is this current?", and a to-the-second value implies more
 * precision than an ingestion timestamp has.
 */
export function formatRelativeTime(date: Date, now: Date): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const magnitude = Math.abs(seconds);
  if (magnitude < 45) return "just now";
  if (magnitude < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (magnitude < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86_400), "day");
}
