import type { Locale } from "@/lib/i18n/routing";

/*
 * Locale formats from ui-context § 11: `12 Sep 2026` / `12 set 2026`,
 * `03 Sep 17:05` / `03 set 17:05`, 24-hour clock in both. Dates are formatted
 * in UTC until accounts carry a time zone. Only these functions format a date.
 */

/** Intl locale used for month names: en-US gives "Sep" (en-GB gives "Sept"). */
const MONTH_LOCALE: Record<Locale, string> = {
  en: "en-US",
  pt: "pt-BR",
};

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function monthShort(date: Date, locale: Locale): string {
  const raw = new Intl.DateTimeFormat(MONTH_LOCALE[locale], { month: "short", timeZone: "UTC" }).format(date);
  const bare = raw.replace(/\.$/, "");
  return locale === "pt" ? bare.toLowerCase() : bare;
}

/** `1,433,086` / `1.433.086`, at most two decimals, tabular digits being the font's job (ui-context § 13.5). */
export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(MONTH_LOCALE[locale], { maximumFractionDigits: 2 }).format(value);
}

/** A multiplier of the rubric, always with one decimal: `1.0`, `0.8` / `1,0`, `0,8` (ui-context § 7). */
export function formatFactor(value: number, locale: Locale): string {
  return new Intl.NumberFormat(MONTH_LOCALE[locale], { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

/** `15 Sep` / `15 set` */
export function formatDayMonth(date: Date, locale: Locale): string {
  return `${two(date.getUTCDate())} ${monthShort(date, locale)}`;
}

/** `20 Sep 21:14` / `20 set 21:14` */
export function formatDayMonthTime(date: Date, locale: Locale): string {
  return `${formatDayMonth(date, locale)} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

/** `21 Sep 2026` / `21 set 2026` */
export function formatDate(date: Date, locale: Locale): string {
  return `${formatDayMonth(date, locale)} ${date.getUTCFullYear()}`;
}

/**
 * `10:42`: the turn's own time in the dock's log. No locale argument, because ui-context § 11 puts both languages
 * on the 24-hour clock and there is nothing else in it to localise.
 */
export function formatTime(date: Date): string {
  return `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

/** `14:02:31`: a save's time to the second, the suggest form's `autosaved 14:02:31` (feature-specs/34 § 5). No locale, as `formatTime`. */
export function formatClock(date: Date): string {
  return `${formatTime(date)}:${two(date.getUTCSeconds())}`;
}

/** `21 Sep 2026 06:00` / `21 set 2026 06:00` */
export function formatDateTime(date: Date, locale: Locale): string {
  return `${formatDate(date, locale)} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

/**
 * `2 min 14 s`, `14 s`, `1 h 3 min`: how long a research run took (feature-specs/48 § 11.3), whole seconds rounded
 * down, the larger unit only where it is not zero (ui-context § 13.5). Locale-neutral: `h`, `min` and `s` are the same
 * in both editions.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${String(hours)} h ${String(minutes)} min`;
  if (minutes > 0) return `${String(minutes)} min ${String(seconds % 60)} s`;
  return `${String(seconds)} s`;
}

/** Milliseconds → seconds to two decimals: `380` → `"0.38"`. Locale-neutral: it sits in a mono status cell. */
export function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}

/**
 * `1.84 M` / `1,84 M`: a count of tokens in millions (the budget meter, feature-specs/21 § 4.2). Two decimals as
 * the screen prints them, three for the pace a day (`0.088 M`). Nothing at all is `0`, not `0.00 M`.
 */
export function formatMillions(tokens: number, locale: Locale, digits = 2): string {
  if (tokens === 0) return "0";
  return `${new Intl.NumberFormat(MONTH_LOCALE[locale], { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(tokens / 1_000_000)} M`;
}

/** `0.68` / `0,68`: an agreement statistic, κ, always to two decimals (feature-specs/36 § 6.4). */
export function formatKappa(value: number, locale: Locale): string {
  return new Intl.NumberFormat(MONTH_LOCALE[locale], { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** `73.6` / `73,6`: a percentage to one decimal; the sign belongs to the string that carries it. */
export function formatPercent(value: number, locale: Locale): string {
  return new Intl.NumberFormat(MONTH_LOCALE[locale], { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

/**
 * `22.8 MB` / `22,8 MB`: the most a type may weigh, as the upload form words it, at 1024 × 1024 bytes to the MB as D2
 * counts its 100 MB (lib/schemas/storage.ts), to one decimal and rounded down, so that a file under the number shown
 * is under the limit (unit 51d's review: rounded to the nearest, 7,500,000 bytes read 7.2 MB, and a file of 7.18 MB
 * was refused under it).
 */
export function formatMegabytes(bytes: number, locale: Locale): string {
  return `${new Intl.NumberFormat(MONTH_LOCALE[locale], { maximumFractionDigits: 1 }).format(Math.floor((bytes / (1024 * 1024)) * 10) / 10)} MB`;
}

/** `september 2026` / `setembro 2026`: the month a meter covers, lower case as a caption prints it. */
export function formatMonthYear(date: Date, locale: Locale): string {
  const month = new Intl.DateTimeFormat(MONTH_LOCALE[locale], { month: "long", timeZone: "UTC" }).format(date).toLowerCase();
  return `${month} ${date.getUTCFullYear()}`;
}
