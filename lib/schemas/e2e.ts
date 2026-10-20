import { z } from "zod";

/*
 * The end-to-end suite's report (unit 23d): what `npm run test:e2e` leaves in pipeline/reports/ and
 * `npm run gate:phase1` reads for three criteria — P1.4 (a cross-reference opens a peek and `esc` returns focus),
 * P1.6 (a reading path resumes on another device) and P1.9 (the reader's primary flows in EN and PT with zero axe
 * violations, and the keyboard map on every reader page).
 *
 * Each test writes its own part as it finishes, whether it passed or not, and the run's teardown gathers the parts:
 * a runner discards its worker after a failed test, so nothing a test learned may live in memory alone.
 */

export const E2E_LOCALES = ["en", "pt"] as const;
export type E2eLocale = (typeof E2E_LOCALES)[number];

/** The reader's primary flows (project-overview § Core user flow, steps 1 to 4, and the Reader's features). Each runs in EN and in PT. */
export const E2E_FLOWS = ["home-to-section", "read-a-section", "search", "reading-path", "marks", "account"] as const;
export type E2eFlowId = (typeof E2E_FLOWS)[number];

/** The three reading paths (feature-specs/05). */
export const E2E_PATHS = ["executive", "builder", "foundations"] as const;

export const AxeFindingSchema = z.object({
  /** Where in the flow the page was scanned: `home`, `section 21.3`, `search results`. */
  screen: z.string(),
  rule: z.string(),
  nodes: z.number().int(),
  /** The first offending node's selector. */
  target: z.string(),
});
export type AxeFinding = z.infer<typeof AxeFindingSchema>;

export const E2eFlowSchema = z.object({
  kind: z.literal("flow"),
  id: z.enum(E2E_FLOWS),
  locale: z.enum(E2E_LOCALES),
  passed: z.boolean(),
  /** Why it did not, in one line; null when it passed. */
  failure: z.string().nullable(),
  /** Screens of the flow scanned with axe, and what axe found on them (WCAG 2.2 AA). */
  screens: z.number().int(),
  axe: z.array(AxeFindingSchema),
});
export type E2eFlow = z.infer<typeof E2eFlowSchema>;

export const E2eKeyboardSchema = z.object({
  kind: z.literal("keyboard"),
  locale: z.enum(E2E_LOCALES),
  /** Reader pages reached with the keyboard from the book's first section, the first included: `j` inside a chapter, `]` into the next. */
  walked: z.number().int(),
  /** Of those, how many answered `?` with the map and `esc` by closing it. */
  helped: z.number().int(),
  /** Each key of the map that was tried, and whether every try did what the map says. */
  keys: z.record(z.string(), z.boolean()),
  failures: z.array(z.string()),
});
export type E2eKeyboard = z.infer<typeof E2eKeyboardSchema>;

export const E2ePeekSchema = z.object({
  kind: z.literal("peek"),
  locale: z.enum(E2E_LOCALES),
  /** Reader pages looked through for cross-references. */
  sections: z.number().int(),
  /** Cross-references found in the prose of those pages, every one of them clicked. */
  references: z.number().int(),
  /** The distinct targets those references name, and how many of each kind. */
  targets: z.number().int(),
  kinds: z.record(z.string(), z.number().int()),
  /** Of the references: the peek opened; the reader was still on its section; `esc` closed it and focus was back on the reference. */
  opened: z.number().int(),
  stayed: z.number().int(),
  focusReturned: z.number().int(),
  failures: z.array(z.string()),
});
export type E2ePeek = z.infer<typeof E2ePeekSchema>;

export const E2eResumeSchema = z.object({
  kind: z.literal("resume"),
  path: z.enum(E2E_PATHS),
  /** The section read in the first browser context. */
  read: z.string(),
  /** Where the path's resume control led in a second context of the same account; null when there was none. */
  landed: z.string().nullable(),
  ok: z.boolean(),
  failure: z.string().nullable(),
});
export type E2eResume = z.infer<typeof E2eResumeSchema>;

export const E2ePartSchema = z.discriminatedUnion("kind", [E2eFlowSchema, E2eKeyboardSchema, E2ePeekSchema, E2eResumeSchema]);
export type E2ePart = z.infer<typeof E2ePartSchema>;

export const E2eReportSchema = z.object({
  release: z.string(),
  ranAt: z.string(),
  baseUrl: z.string(),
  flows: z.array(E2eFlowSchema),
  keyboard: z.array(E2eKeyboardSchema),
  peek: z.array(E2ePeekSchema),
  resume: z.array(E2eResumeSchema),
});
export type E2eReport = z.infer<typeof E2eReportSchema>;

export function e2eReportName(release: string): string {
  return `e2e-${release}.json`;
}
