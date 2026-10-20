import { z } from "zod";

/*
 * The PT truncation suite's report (unit 23c): what `npm run test:layout` writes to pipeline/reports/ and
 * `npm run gate:phase1` reads for criterion P1.8. One file per release; a run replaces it.
 */

/** How a label can fail the rule "labels wrap, never truncate" (ui-context § 11, § 13.7). */
export const LAYOUT_FINDING_KINDS = ["ellipsis", "line-clamp", "clipped", "clipped-vertically", "spills", "page-overflow"] as const;

export const LayoutFindingSchema = z.object({
  kind: z.enum(LAYOUT_FINDING_KINDS),
  /** The element as `tag.class.class`, enough to find its rule. */
  element: z.string(),
  /** The start of its text, as rendered. */
  text: z.string(),
  /** By how many pixels the content exceeds its box, or the page its viewport. */
  by: z.number(),
});
export type LayoutFinding = z.infer<typeof LayoutFindingSchema>;

export const LayoutScreenSchema = z.object({
  id: z.string(),
  path: z.string(),
  /** The viewport's width: 1440 or 390 (ui-context § 14.5). */
  viewport: z.number().int(),
  /** Elements with text that were measured. */
  labels: z.number().int(),
  findings: z.array(LayoutFindingSchema),
});
export type LayoutScreen = z.infer<typeof LayoutScreenSchema>;

export const TruncationReportSchema = z.object({
  release: z.string(),
  ranAt: z.string(),
  baseUrl: z.string(),
  /** The fixture against the criterion: every string at least 30 % longer than its EN counterpart. */
  fixture: z.object({ strings: z.number().int(), exempt: z.number().int(), padded: z.number().int(), short: z.array(z.string()) }),
  screens: z.array(LayoutScreenSchema),
  /** Screens that could not be rendered, each with why: a suite that skipped one has not passed. */
  skipped: z.array(z.object({ id: z.string(), viewport: z.number().int(), reason: z.string() })),
});
export type TruncationReport = z.infer<typeof TruncationReportSchema>;

export function truncationReportName(release: string): string {
  return `pt-truncation-${release}.json`;
}
