import { z } from "zod";

/*
 * The assistant's series (feature-specs/21 § 5.3): what a statement of `lib/metrics/sql/` returns and what
 * `lib/metrics/assistant.ts` hands on. Every statement returns the same five columns, so one schema reads them all
 * and the dashboard's panels can be told apart by their SQL alone.
 */

/** One row of a series statement. Counts and sums arrive as `float8`, so nothing here is a bigint or a Decimal. */
export const MetricRowSchema = z.object({
  /** The start of the day or of the month the row covers, UTC as stored. */
  bucket: z.date(),
  /** The line within the series: a refusal cause, a flag's reason, `p50`; empty when the series has one line. */
  key: z.string(),
  /** The numerator, when the value is a ratio or a count. */
  n: z.number().nullable(),
  /** The denominator, or the number of samples behind a percentile. */
  d: z.number().nullable(),
  /** The measure itself; null when its denominator is zero. */
  value: z.number().nullable(),
});

export type MetricRow = z.infer<typeof MetricRowSchema>;

export const METRIC_BUCKETS = ["day", "month"] as const;
export type MetricBucket = (typeof METRIC_BUCKETS)[number];

/** How a value reads: a share of one, milliseconds, US dollars, a score between 0 and 1, a count. */
export type MetricUnit = "share" | "ms" | "usd" | "score" | "count";

export interface MetricPoint {
  /** `2026-09-21` for a day, `2026-09` for a month. */
  readonly bucket: string;
  readonly key: string;
  readonly n: number | null;
  readonly d: number | null;
  readonly value: number | null;
}

export interface MetricSeries {
  readonly series: string;
  readonly unit: MetricUnit;
  /** `[from, to)`, ISO-8601. */
  readonly window: { readonly from: string; readonly to: string };
  /** One point per day that has rows, per key. */
  readonly points: ReadonlyArray<MetricPoint>;
  /** The same statement by calendar month: for a window of one month, the month to date. */
  readonly months: ReadonlyArray<MetricPoint>;
}
