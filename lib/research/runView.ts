import type { ResolvedAnchor } from "@/lib/db/anchors";
import type { Lang } from "@/lib/db/generated/enums";
import { changeOf } from "@/lib/improve/outcomeView";
import { proposalTexts } from "@/lib/improve/proposal";
import { classOf } from "@/lib/rubric/changeClass";
import type { FINDING_USES, ProposalView, ResearchFindingView, ResearchPageView, ResearchRunLine, ResearchRunView } from "@/lib/schemas/api";
import type { SuggestionState } from "@/lib/schemas/improve";
import type { FindingOutcome, ResearchRefusal, ResearchSkip, ResearchState } from "@/lib/schemas/research";
import type { ReaderFinding, Report, ResearchFound, ResearchStep } from "@/lib/schemas/researcher";
import { RESEARCH_RUN_EXECUTION_TIMEOUT_MS } from "@/lib/schemas/workflows";
import { OT_POINTERS } from "@/lib/sensors/scope";

/*
 * A person's run as the page shows it (feature-specs/48 § 16, § 18; unit 71), pure: the line its state, skip and failure
 * give, whether nothing will move it any more (§ 6, stale), the pages from its steps until the reader answered and then
 * from the turn's own list, each finding that passed the checks numbered 1 to n with its change and class as a
 * submission would compute them, and the refusal's pointers. The door (`lib/db/research.ts`) reads the rows and the
 * book's side and hands them here; nothing here reads a row, and nothing here passes on the brief, the reader's notes on
 * the pages, an invalid finding, the reader's ordinals or a failure's code (§ 16).
 */

/** A person's run as the view reads its row: no text but the question, which the page shows its asker. */
export interface RunViewRow {
  readonly id: string;
  readonly conversationId: string;
  readonly ordinal: number;
  readonly locale: Lang;
  readonly question: string | null;
  readonly state: ResearchState;
  readonly skip: ResearchSkip | null;
  /** A code, never shown (spec 43 D10): it picks the line's words alone. */
  readonly failure: string | null;
  readonly refusal: ResearchRefusal | null;
  readonly sectionAnchors: ReadonlyArray<string>;
  readonly budgetResetsAt: Date | null;
  readonly searches: number;
  readonly pageReads: number;
  readonly flagReason: string | null;
  readonly flaggedAt: Date | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
  readonly textPurgedAt: Date | null;
}

/**
 * The line of a run and whether it is stale (§ 6, § 18). The states under way are the ones a run's workflow moves it
 * through (the complement of `ENDED_STATES`); one still under way 90 minutes after it was created — the workflow's
 * own execution timeout — has nothing left to move it, and reads `no answer from the engine` until the next start ends
 * its row `FAILED · ABANDONED` (§ 5.2 check 3). `SUBMITTING` and `WAITING_BUDGET` are a legacy run's, which a person's
 * run never reaches; they read as under way, as they are.
 */
export function runLineOf(run: Pick<RunViewRow, "state" | "skip" | "failure" | "createdAt" | "textPurgedAt">, now: Date): { readonly line: ResearchRunLine; readonly stale: boolean } {
  const underWay = (key: ResearchRunLine["key"]): { readonly line: ResearchRunLine; readonly stale: boolean } =>
    now.getTime() - run.createdAt.getTime() > RESEARCH_RUN_EXECUTION_TIMEOUT_MS ? { line: { key: "abandoned", tone: "mute" }, stale: true } : { line: { key, tone: "run" }, stale: false };
  const ended = (key: ResearchRunLine["key"], tone: ResearchRunLine["tone"]): { readonly line: ResearchRunLine; readonly stale: boolean } => ({ line: { key, tone }, stale: false });
  switch (run.state) {
    case "QUEUED":
    case "WAITING_BUDGET":
      return underWay("queued");
    case "PLANNING":
      return underWay("planning");
    case "READING":
      return underWay("reading");
    case "VALIDATING":
    case "SUBMITTING":
      return underWay("checking");
    case "WRITING":
      return underWay("writing");
    case "DONE":
      return ended(run.textPurgedAt === null ? "done" : "donePurged", "ok");
    case "REFUSED":
      return ended("refused", "mute");
    case "SKIPPED":
      if (run.skip === "BUDGET") return ended("notStarted", "warn");
      if (run.skip === "TEXT_PURGED") return ended("purged", "mute");
      return ended("notRun", "mute");
    case "FAILED":
      if (run.failure === "BUDGET") return ended("stopped", "warn");
      if (run.failure === "ABANDONED") return ended("abandoned", "mute");
      return ended("failed", "mute");
    default: {
      const never: never = run.state;
      return never;
    }
  }
}

/** A page's host for its row; the address itself where it does not parse, so a row always says where it goes. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

/**
 * The pages a run read (§ 16), numbered as its report cites them: the turn's own list (`found.read`) once the reader has
 * answered, every page it saw in order of appearance; before that, the pages its steps have opened so far. None once
 * the run's text is purged.
 */
export function pagesOf(found: Pick<ResearchFound, "read"> | null, steps: ReadonlyArray<ResearchStep>, textPurged: boolean): ReadonlyArray<ResearchPageView> {
  if (textPurged) return [];
  if (found?.read !== undefined) return found.read.map((page, index) => ({ n: index + 1, url: page.url, host: hostOf(page.url), title: page.title, opened: page.opened, search: page.search }));
  return steps.flatMap((step) => (step.kind === "PAGE" ? [step] : [])).map((step, index) => ({ n: index + 1, url: step.url, host: hostOf(step.url), title: step.title, opened: step.opened === true, search: null }));
}

/** The sections a refused run's card points at (§ 5.2, § 5.3): the Assistant's two for plant equipment; the run's first two sections for one not about the book; none otherwise, as the Assistant gives none for an unverified chapter. */
export function refusalPointerIdsOf(cause: ResearchRefusal, sectionAnchors: ReadonlyArray<string>): ReadonlyArray<string> {
  if (cause === "R-SCOPE-OT") return OT_POINTERS;
  if (cause === "R-SCOPE") return sectionAnchors.slice(0, 2);
  return [];
}

type FindingUse = (typeof FINDING_USES)[number];

/** A finding's use as the person is shown it (§ 8.1); an `INVALID` finding has none, since it is never shown. */
const USE_OF: Readonly<Record<Exclude<FindingOutcome, "INVALID">, FindingUse>> = { VALID: "VALID", DRAFTED: "DRAFTED", SUBMITTED: "SENT", DUPLICATE: "DUPLICATE", PROPOSED: "PROPOSED", REFUTED: "REFUTED" };

/** A finding's row as the view reads it: its own id, its outcome, the suggestion it names and the code a send failed with. */
export interface FindingRow {
  readonly id: string;
  readonly outcome: Exclude<FindingOutcome, "INVALID">;
  readonly suggestionId: string | null;
  readonly failure: string | null;
}

/** What the door read of a used finding's suggestion, which says what the person may be shown of it (§ 8.1, § 8.5; unit 74). */
export interface FindingUseFacts {
  /** A drafted finding's draft as its owner's own read finds it: its state; null where there is none — deleted, or the finding is no draft. */
  readonly draftState: SuggestionState | null;
  /** A duplicate's suggestion is the person's to be told: their own, merged, or a proposal they asked (`duplicateVisibleTo`). */
  readonly duplicateVisible: boolean;
}

/** What the door read for a finding: what the reader wrote, where its run's text is held; its anchor resolved in the current release, and that section's title; the proposal's panel for a proposed one; its suggestion's facts. */
export interface FindingFacts {
  readonly finding: ReaderFinding | null;
  readonly anchor: Pick<ResolvedAnchor, "kind" | "sectionAnchor" | "figureAnchor" | "tier" | "scenarioParam" | "currentText"> | null;
  readonly title: string | null;
  readonly proposal: ProposalView | null;
  readonly use: FindingUseFacts;
}

/**
 * A finding's use as the person is shown it (§ 8.1, § 8.5, D3; unit 74): its state; the suggestion's id where it is
 * theirs to see — their own draft, the proposal they asked, a duplicate of their own, of a proposal they asked or of a
 * merged suggestion — and never a sent one's still being checked or a refuted one's, whose record is not the asker's to
 * read; the path it opens under the page's locale — a draft's edit page while it is a draft and its own page after, a
 * visible duplicate's record — or null; and the code a send failed with, for a finding still unused.
 */
export function findingUseOf(row: FindingRow, facts: FindingUseFacts): ResearchFindingView["use"] {
  const state = USE_OF[row.outcome];
  const failure = state === "VALID" ? row.failure : null;
  const id = row.suggestionId;
  if (id === null) return { state, suggestionId: null, href: null, failure };
  switch (state) {
    case "DRAFTED":
      return { state, suggestionId: id, href: facts.draftState === null ? null : facts.draftState === "DRAFT" ? `/improve/${id}/edit` : `/improve/${id}`, failure };
    case "PROPOSED":
      /* its panel carries the record (spec 43 § 5.3) */
      return { state, suggestionId: id, href: null, failure };
    case "DUPLICATE":
      return facts.duplicateVisible ? { state, suggestionId: id, href: `/improve/${id}/record`, failure } : { state, suggestionId: null, href: null, failure };
    case "VALID":
    case "SENT":
    case "REFUTED":
      return { state, suggestionId: null, href: null, failure };
    default: {
      const never: never = state;
      return never;
    }
  }
}

const HTTPS = /^https:\/\//i;

/**
 * A finding that passed the checks, as the person is shown it (§ 16). The class and the change are computed as the
 * submission computes them (lib/research/submission.ts `submissionOf`): the class by the passage for a section and by
 * the anchor's text otherwise, the change by `changeOf`, both against the anchor as the current release has it — the
 * class a draft or a send of it would be given (§ 8.2 step 4). An anchor the release no longer has keeps its kind and
 * id with no section, class or change. A suggestion's id reaches the person only where it is theirs to see
 * (`findingUseOf`; § 8.5, D3).
 */
export function findingViewOf(row: FindingRow, n: number, textPurged: boolean, facts: FindingFacts): ResearchFindingView {
  const use = findingUseOf(row, facts.use);
  const base = { id: row.id, n, textPurged, use, proposal: use.state === "PROPOSED" ? facts.proposal : null };
  const { finding, anchor } = facts;
  if (textPurged || finding === null) return { ...base, anchor: null, changeKind: null, changeClass: null, curatorReason: null, change: null, sources: null, note: null };
  const sources = [...new Set(finding.sources.map((source) => source.url.trim()).filter((url) => HTTPS.test(url)))].map((url) => ({ url, host: hostOf(url) }));
  const common = { ...base, changeKind: finding.changeKind, sources, note: finding.note };
  if (anchor === null) return { ...common, anchor: { kind: finding.anchor.kind, id: finding.anchor.id, section: null, title: null }, changeClass: null, curatorReason: null, change: null };
  const texts = proposalTexts(finding.proposal);
  const judged = anchor.kind === "SECTION" ? texts.anchoredPassage : anchor.currentText;
  const classified = classOf({ kind: anchor.kind, figure: anchor.figureAnchor === null ? null : { tier: anchor.tier ?? "OPEN", scenarioParam: anchor.scenarioParam }, text: judged }, finding.changeKind, { text: texts.proposedText, sourceTier: texts.sourceTier });
  const change = changeOf({ anchor: { currentText: anchor.currentText }, proposal: finding.proposal });
  return {
    ...common,
    anchor: { kind: finding.anchor.kind, id: finding.anchor.id, section: anchor.sectionAnchor, title: facts.title },
    changeClass: classified.changeClass,
    curatorReason: classified.curatorReason,
    change: { before: change.before, after: change.after },
  };
}

/** What the door gathered for a run besides its row: its steps, report and found as parsed, the targets' and the pointers' titles, its findings' views and its cost. */
export interface RunViewParts {
  /** The seeded run of a research seeded from an Assistant answer (A6): no earlier run of it planned (`isSeededRun`, lib/db/research.ts). */
  readonly seeded: boolean;
  readonly steps: ReadonlyArray<ResearchStep>;
  readonly report: Report | null;
  readonly found: ResearchFound | null;
  readonly sections: ReadonlyArray<{ readonly id: string; readonly title: string | null }>;
  readonly pointers: ReadonlyArray<{ readonly sectionId: string; readonly title: string }>;
  readonly findings: ReadonlyArray<ResearchFindingView>;
  readonly costUsd: string | null;
}

/** The run's view (§ 16): the report's paragraphs alone, never what the sensor dropped; the refusal's card for a refused run; the usage from the row's counts and the turn's list. */
export function runViewOf(run: RunViewRow, parts: RunViewParts, now: Date): ResearchRunView {
  const textPurged = run.textPurgedAt !== null;
  const { line, stale } = runLineOf(run, now);
  return {
    id: run.id,
    conversationId: run.conversationId,
    ordinal: run.ordinal,
    question: run.question,
    language: run.locale === "PT" ? "pt" : "en",
    seeded: parts.seeded,
    state: run.state,
    line,
    stale,
    refusal: run.state === "REFUSED" && run.refusal !== null ? { cause: run.refusal, code: run.refusal, pointers: [...parts.pointers], beforeRetrieval: true } : null,
    resetsAt: run.budgetResetsAt === null ? null : run.budgetResetsAt.toISOString(),
    steps: textPurged ? [] : [...parts.steps],
    sections: [...parts.sections],
    report: textPurged || parts.report === null ? null : { paragraphs: parts.report.paragraphs.map((paragraph) => ({ text: paragraph.text, sections: [...paragraph.sections], pages: [...paragraph.pages] })) },
    pages: [...pagesOf(parts.found, parts.steps, textPurged)],
    findings: [...parts.findings],
    usage: { searches: run.searches, pagesOpened: run.pageReads, pagesSeen: textPurged ? null : (parts.found?.read?.length ?? null), costUsd: parts.costUsd },
    flag: run.flaggedAt !== null && run.flagReason !== null ? { kind: run.refusal !== null ? "refusal" : "report", reason: run.flagReason } : null,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
    textPurged,
  };
}
