import type { Criterion, GateReportBase } from "@/lib/gate/common";
import { E2E_FLOWS, E2E_LOCALES, E2E_PATHS, type E2eReport } from "@/lib/schemas/e2e";
import type { TruncationReport } from "@/lib/schemas/layout";
import { CITE_SOURCE, MATH_SOURCE, NUM_SOURCE, SECTION_REF_SOURCE, SKIP_SOURCE } from "@/pipeline/parse/figures";

/*
 * The Phase 1 gate (project-overview § Success criteria · Phase 1): the pure
 * rules behind `npm run gate:phase1`. The runner in scripts/phase1-gate.ts
 * measures; this module counts, ranks and formats. "Done means every item
 * below can be demonstrated, not asserted", so every criterion carries what
 * was measured and how, and the gate is met only when every one passes.
 */

/* The criterion, the verdict, the percentile and the report are every phase's (lib/gate/common.ts, since unit 36a);
   they are re-exported here so that what imports them from this file keeps working. */
export { formatGateReport, gateVerdict, percentile, type Criterion, type CriterionStatus } from "@/lib/gate/common";

export interface GateReport extends GateReportBase {
  readonly phase: 1;
}

/* chips, derive links, cross-references, source links and every figure span (cited and open figures carry `data-figure` and no class) */
const PROTECTED_RE = /<(span|a)\b[^>]*(?:class="(?:chip|derive|xref|src|fig-[a-z]+)[^"]*"|data-figure="[^"]*")[^>]*>[\s\S]*?<\/\1>/g;
const YEAR_RE = /\b(?:19|20)\d{2}\b/g;

function blank(text: string, re: RegExp): string {
  return text.replace(re, (m) => " ".repeat(m.length));
}

/**
 * Numbers standing bare in a section's stored prose: inside `<p>` paragraphs,
 * outside chips, derive links, cross-references, source links and figure
 * spans, and outside the pipeline's own exclusions (tier parentheticals,
 * "Figure 3"-style labels, section references, inline math, bare years,
 * which the linter reads as primary citations). The same token grammar as
 * the pipeline's figure pass (`NUM_SOURCE`), so the count matches its
 * "numbers without a tier tag" warning on the source markdown.
 */
export function bareNumbers(html: string): ReadonlyArray<{ readonly token: string; readonly context: string }> {
  const out: Array<{ token: string; context: string }> = [];
  for (const m of html.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)) {
    const paragraph = m[1];
    let text = blank(paragraph, PROTECTED_RE);
    text = blank(text, /<[^>]*>/g);
    text = blank(text, /&#?\w+;/g);
    text = blank(text, new RegExp(CITE_SOURCE, "gi"));
    text = blank(text, new RegExp(SKIP_SOURCE, "g"));
    text = blank(text, new RegExp(SECTION_REF_SOURCE, "g"));
    text = blank(text, new RegExp(MATH_SOURCE, "g"));
    text = blank(text, YEAR_RE);
    for (const n of text.matchAll(new RegExp(NUM_SOURCE, "g"))) {
      const token = n[0].trimEnd().replace(/,+$/, "");
      if (token.length === 0) continue;
      const at = n.index ?? 0;
      const context = text.slice(Math.max(0, at - 30), Math.min(text.length, at + token.length + 30)).replace(/\s+/g, " ").trim();
      out.push({ token, context });
    }
  }
  return out;
}

export const P1_8_TEXT = "A PT label truncation snapshot suite passes with every string at least 30% longer than its EN counterpart in the fixture.";

/**
 * P1.8 from the suite's own report (unit 23c; `npm run test:layout` writes it, tests/layout/). The gate does not
 * open a browser: it reads what the suite measured, as it reads the golden run's file for Phase 2. A report of
 * another release, or one in which a screen was not rendered, has not measured this release's screens and is
 * `blocked`, not a pass.
 */
export function truncationCriterion(report: TruncationReport | null, release: string): Criterion {
  const how = "npm run test:layout renders the primary screens in PT with the padded catalogue (lib/i18n/pad.ts) at 1440px and 390px and measures every element that holds text for an ellipsis, a line clamp, clipped or spilling text, and a page that scrolls sideways (tests/layout/).";
  if (report === null) return { id: "P1.8", text: P1_8_TEXT, status: "blocked", measured: "the suite has not been run", note: `${how} It needs a development server: the padded catalogue and the dev sign-in are refused in production.` };
  if (report.release !== release) return { id: "P1.8", text: P1_8_TEXT, status: "blocked", measured: `the suite's report is of release ${report.release}`, note: `${how} Run it again on this release.` };

  const renders = report.screens.length;
  const labels = report.screens.reduce((sum, screen) => sum + screen.labels, 0);
  const findings = report.screens.flatMap((screen) => screen.findings.map((finding) => ({ screen, finding })));
  const fixture = `fixture ${String(report.fixture.strings)} strings · ${String(report.fixture.padded)} lengthened · ${String(report.fixture.exempt)} with no label`;
  const ran = `Run ${report.ranAt.slice(0, 10)} against ${report.baseUrl}.`;

  if (report.fixture.short.length > 0) {
    return { id: "P1.8", text: P1_8_TEXT, status: "fail", measured: `${String(report.fixture.short.length)} fixture strings are not 30 % longer than their EN counterpart`, note: `${how} First: ${report.fixture.short.slice(0, 3).join(", ")}. ${ran}` };
  }
  if (findings.length > 0) {
    const first = findings.slice(0, 3).map(({ screen, finding }) => `${String(screen.viewport)} ${screen.id} · ${finding.kind} · ${finding.element}`).join("; ");
    const screens = new Set(findings.map(({ screen }) => `${String(screen.viewport)} ${screen.id}`)).size;
    return { id: "P1.8", text: P1_8_TEXT, status: "fail", measured: `${String(findings.length)} truncated labels on ${String(screens)} of ${String(renders)} renders · ${fixture}`, note: `${how} First: ${first}. ${ran}` };
  }
  if (report.skipped.length > 0) {
    const first = report.skipped[0];
    return { id: "P1.8", text: P1_8_TEXT, status: "blocked", measured: `${String(renders)} renders measured, ${String(report.skipped.length)} not rendered`, note: `${how} Not rendered: ${first === undefined ? "" : `${String(first.viewport)} ${first.id} (${first.reason})`}. ${ran}` };
  }
  return { id: "P1.8", text: P1_8_TEXT, status: "pass", measured: `${String(renders)} renders · ${String(labels)} labels · 0 truncated · ${fixture}`, note: `${how} Every fixture string with a label is at least 30 % longer than its EN counterpart. ${ran}` };
}

/*
 * The three criteria the end-to-end suite measures (unit 23d; `npm run test:e2e` writes the report, tests/e2e/). As
 * with P1.8 the gate opens no browser: it reads what the suite did. What the suite did not run is `blocked`, never a
 * pass, and what it ran and saw fail is a `fail` whatever else is missing.
 */

export const P1_4_TEXT = "Every cross-reference (chNN, NN.N, Lab NN) opens a peek panel without leaving the section, and esc returns focus to the reading position.";
export const P1_6_TEXT = "The three reading paths track progress per account; resuming from another device lands on the same section.";
export const P1_9_TEXT = "Playwright runs the reader's primary flows in PT and EN with zero axe WCAG 2.2 AA violations; the global keyboard map works on every reader page.";

const E2E_HOW = "npm run test:e2e (Playwright, tests/e2e/) against a development server";

/** The suite's report when it is of this release; null when there is none or it measured another release's pages. */
function reportOf(report: E2eReport | null, release: string): E2eReport | null {
  return report !== null && report.release === release ? report : null;
}

function notRun(report: E2eReport | null, release: string): string {
  return report === null ? "the suite has not been run" : report.release === release ? "" : `the suite's report is of release ${report.release}`;
}

/**
 * P1.4. Two measures: the release's cross-references resolve (rows, as before), and in a browser every reference in
 * the prose of every reader page, clicked, opens the peek with the reader still on its section and gives focus back
 * to the reference on `esc`. The browser must have looked through every page and met every target the rows name:
 * a pass over part of the book is not this criterion.
 */
export function peekCriterion(report: E2eReport | null, release: string, sections: number, targets: { readonly total: number; readonly unresolved: ReadonlyArray<string> }): Criterion {
  const resolved = `${String(targets.total - targets.unresolved.length)}/${String(targets.total)} distinct targets resolve in the release`;
  const rows = "Targets checked against the release's sections, chapters, labs and source rows.";
  if (targets.unresolved.length > 0) {
    return { id: "P1.4", text: P1_4_TEXT, status: "fail", measured: `${resolved} · unresolved: ${targets.unresolved.slice(0, 8).join(", ")}`, note: rows };
  }
  const walked = reportOf(report, release)?.peek.find((part) => part.locale === "en") ?? null;
  if (walked === null) {
    return { id: "P1.4", text: P1_4_TEXT, status: "blocked", measured: `${resolved} · ${notRun(report, release) || "the suite did not walk the cross-references"}`, note: `${rows} The peek panel and the esc focus return are browser behaviour: ${E2E_HOW} clicks every distinct reference in the prose.` };
  }
  const every = walked.sections === sections && walked.targets === targets.total;
  const whole = every && walked.references > 0 && walked.opened === walked.references && walked.stayed === walked.references && walked.focusReturned === walked.references && walked.failures.length === 0;
  const kinds = Object.entries(walked.kinds)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([kind, count]) => `${String(count)} ${kind}`)
    .join(", ");
  return {
    id: "P1.4",
    text: P1_4_TEXT,
    status: whole ? "pass" : "fail",
    measured: `${resolved} · ${String(walked.opened)}/${String(walked.references)} references opened a peek · ${String(walked.stayed)} left the reader on its section · ${String(walked.focusReturned)} gave focus back on esc`,
    note: `${rows} In a browser: every reference in the prose of ${String(walked.sections)}/${String(sections)} reader pages (EN) clicked, ${String(walked.targets)}/${String(targets.total)} distinct targets met (${kinds}); ${E2E_HOW}.${walked.failures.length > 0 ? ` First failure: ${walked.failures[0] ?? ""}.` : ""}`,
  };
}

/** P1.6. Each path: a section read in one browser context, and the path's resume control followed in a second context of the same account. */
export function resumeCriterion(report: E2eReport | null, release: string): Criterion {
  const how = `Per-account rows and isolation are covered by tests/integration/paths.test.ts (npm test). The two-device resume: ${E2E_HOW} reads a section of each path in one browser context and follows the path's resume control in a second context of the same account.`;
  const parts = reportOf(report, release)?.resume ?? [];
  const failed = parts.filter((part) => !part.ok);
  if (failed.length > 0) {
    const first = failed[0];
    return { id: "P1.6", text: P1_6_TEXT, status: "fail", measured: `${String(parts.length - failed.length)}/${String(parts.length)} paths resumed on the section read`, note: `${how} ${first === undefined ? "" : `${first.path}: read ${first.read}, landed on ${first.landed ?? "nothing"}${first.failure === null ? "" : ` (${first.failure})`}.`}` };
  }
  const missing = E2E_PATHS.filter((path) => !parts.some((part) => part.path === path));
  if (missing.length > 0) return { id: "P1.6", text: P1_6_TEXT, status: "blocked", measured: notRun(report, release) || `${String(parts.length)}/${String(E2E_PATHS.length)} paths resumed; not run: ${missing.join(", ")}`, note: how };
  return { id: "P1.6", text: P1_6_TEXT, status: "pass", measured: `${String(parts.length)}/${String(E2E_PATHS.length)} paths resumed in a second browser context on the section read in the first (${parts.map((part) => `${part.path} ${part.read}`).join(", ")})`, note: how };
}

/** P1.9. Every flow in both languages with nothing for axe to find, and the keyboard map on every reader page of the release. */
export function flowsCriterion(report: E2eReport | null, release: string, sections: number): Criterion {
  const how = `${E2E_HOW}: ${String(E2E_FLOWS.length)} flows (${E2E_FLOWS.join(", ")}), each in EN and PT, every screen scanned with axe for WCAG 2.2 AA; the keyboard map by walking the whole book with j and ], asking for the map with ? and closing it with esc on every page.`;
  const current = reportOf(report, release);
  const flows = current?.flows ?? [];
  const keyboard = current?.keyboard ?? [];
  const axe = flows.reduce((sum, flow) => sum + flow.axe.length, 0);
  const screens = flows.reduce((sum, flow) => sum + flow.screens, 0);
  const failedFlows = flows.filter((flow) => !flow.passed);
  const badWalks = keyboard.filter((walk) => walk.failures.length > 0 || walk.walked !== sections || walk.helped !== walk.walked || Object.values(walk.keys).some((worked) => !worked));
  const pages = keyboard.map((walk) => `${walk.locale.toUpperCase()} ${String(walk.walked)}/${String(sections)}`).join(", ");

  if (failedFlows.length > 0 || badWalks.length > 0) {
    const firstFlow = failedFlows[0];
    const firstWalk = badWalks[0];
    const why = firstFlow !== undefined ? `${firstFlow.id} (${firstFlow.locale}): ${firstFlow.failure ?? ""}` : firstWalk !== undefined ? `keyboard (${firstWalk.locale}): ${firstWalk.failures[0] ?? `${String(firstWalk.walked)} of ${String(sections)} pages walked, ${String(firstWalk.helped)} answered ?`}` : "";
    return { id: "P1.9", text: P1_9_TEXT, status: "fail", measured: `${String(flows.length - failedFlows.length)}/${String(flows.length)} flows passed · ${String(axe)} axe violations on ${String(screens)} screens · keyboard map ${pages === "" ? "not walked" : pages}`, note: `${how} First failure: ${why}.` };
  }
  const missingFlows = E2E_FLOWS.flatMap((id) => E2E_LOCALES.filter((locale) => !flows.some((flow) => flow.id === id && flow.locale === locale)).map((locale) => `${id} (${locale})`));
  const missingWalks = E2E_LOCALES.filter((locale) => !keyboard.some((walk) => walk.locale === locale));
  if (missingFlows.length > 0 || missingWalks.length > 0) {
    const missing = [...missingFlows, ...missingWalks.map((locale) => `keyboard (${locale})`)];
    return { id: "P1.9", text: P1_9_TEXT, status: "blocked", measured: notRun(report, release) || `${String(flows.length)}/${String(E2E_FLOWS.length * E2E_LOCALES.length)} flows and ${String(keyboard.length)}/${String(E2E_LOCALES.length)} keyboard walks run; not run: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""}`, note: how };
  }
  return { id: "P1.9", text: P1_9_TEXT, status: "pass", measured: `${String(flows.length)} flows passed (${String(E2E_FLOWS.length)} in EN and PT) · 0 axe violations on ${String(screens)} screens · keyboard map on every reader page: ${pages}`, note: how };
}
