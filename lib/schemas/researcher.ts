import { z } from "zod";

import { SectionIdSchema } from "@/lib/schemas/ids";
import { AnchorKindSchema, ChangeKindSchema, ProposalSchema } from "@/lib/schemas/improve";

/*
 * What the researcher's two calls answer (feature-specs/41 § 5.2, § 6.2; unit 58c, 58d): the planner's refusal or its
 * brief with its targets, and the reader's findings. These schemas hold a model's words — the brief, a note, a
 * proposal — so they live apart from lib/schemas/research.ts, whose every schema may cross to the workflow engine and
 * holds none (invariant 35). A parser holds an output to these strictly: a key the guide did not name is a failure,
 * not something to pass along (invariant 10).
 */

/** The three reasons there is nothing to research (41 § 5.2). */
export const PLAN_REASONS = ["COVERED", "NOT_ABOUT_THE_BOOK", "PERSONAL"] as const;
export const PlanReasonSchema = z.enum(PLAN_REASONS);
export type PlanReason = z.infer<typeof PlanReasonSchema>;

export const TARGET_INTENTS = ["UPDATE", "GAP", "CONTRADICTION"] as const;
export const TargetIntentSchema = z.enum(TARGET_INTENTS);
export type TargetIntent = z.infer<typeof TargetIntentSchema>;

/** The brief's and the note's limit: the product's own limit for a text that explains what evidence should show (the rationale's 200 words; 41 § 5.2, § 6.2). */
export const BRIEF_WORDS_MAX = 200;
export const NOTE_WORDS_MAX = 200;
/** At most three findings a run (A13). */
export const FINDINGS_MAX = 3;

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

const TextSchema = z.string().trim().min(1);

export const PlannerOutputSchema = z.union([
  z.strictObject({ research: z.literal(false), reason: PlanReasonSchema }),
  z.strictObject({
    research: z.literal(true),
    brief: TextSchema,
    targets: z.array(z.strictObject({ section: TextSchema, intent: TargetIntentSchema })).min(1),
  }),
]);
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/**
 * The version 2 planner's two refusals (feature-specs/48 § 5.3): `COVERED` goes, since a person asked for research and
 * pays for it, and "the book covers this" is something the report can say after looking.
 */
export const PLAN_V2_REASONS = ["NOT_ABOUT_THE_BOOK", "PERSONAL"] as const satisfies ReadonlyArray<PlanReason>;
export const PlanV2ReasonSchema = z.enum(PLAN_V2_REASONS);
export type PlanV2Reason = z.infer<typeof PlanV2ReasonSchema>;

/**
 * The version 2 planner's answer (48 § 5.3): a refusal with one of its two reasons, or a brief with one to three
 * targets — the findings' own limit, since a target with no finding to show is a section the reader reads for
 * nothing. A target's section is held to the run's sections by the brief sensor (`TARGET`), not here, so a wrong one
 * is that check's failure and not the parse's. The legacy planner keeps `PlannerOutputSchema`.
 */
export const PlannerOutputV2Schema = z.union([
  z.strictObject({ research: z.literal(false), reason: PlanV2ReasonSchema }),
  z.strictObject({
    research: z.literal(true),
    brief: TextSchema,
    targets: z.array(z.strictObject({ section: TextSchema, intent: TargetIntentSchema })).min(1).max(FINDINGS_MAX),
  }),
]);
export type PlannerOutputV2 = z.infer<typeof PlannerOutputV2Schema>;

/** One finding as the reader writes it (41 § 6.2). The proposal is spec 31 § 4's; the sources are addresses, checked later against the pages the call saw. */
export const ReaderFindingSchema = z.strictObject({
  anchor: z.strictObject({ kind: AnchorKindSchema, id: TextSchema }),
  changeKind: ChangeKindSchema,
  proposal: ProposalSchema,
  sources: z.array(z.strictObject({ url: TextSchema })).min(1),
  note: TextSchema,
});
export type ReaderFinding = z.infer<typeof ReaderFindingSchema>;

/**
 * The reader's answer: a list of findings as the model wrote them, each read later by `ReaderFindingSchema` in the
 * validation (41 § 7), where one of another shape is refused as `PROPOSAL` and the rest stand — a single bad value is
 * one finding's fault, not the run's (review of units 57–58). Any number, since the ones beyond the third are dropped
 * and counted, not refused as a whole.
 */
export const ReaderOutputSchema = z.strictObject({ findings: z.array(z.unknown()) });
export type ReaderOutput = z.infer<typeof ReaderOutputSchema>;

/** A page note's limit: what one page says that bears on the brief, in a sentence or two (feature-specs/48 § 5.4). */
export const PAGE_NOTE_WORDS_MAX = 60;

/** One page's note as the version 2 reader writes it (48 § 5.4): its address and what it says. Read note by note, so one bad note is dropped and counted, not the run's fault. */
export const ReaderNoteSchema = z.strictObject({ url: TextSchema, says: TextSchema });
export type ReaderNote = z.infer<typeof ReaderNoteSchema>;

/**
 * The version 2 reader's answer (feature-specs/48 § 5.4): the findings as before, and a note on each page that bears on
 * the brief, which the writer reads instead of the pages. Strict on both members; each item is read later, a finding
 * by `ReaderFindingSchema` and a note by `ReaderNoteSchema`. The legacy reader keeps `ReaderOutputSchema`.
 */
export const ReaderOutputV2Schema = z.strictObject({ findings: z.array(z.unknown()), notes: z.array(z.unknown()) });
export type ReaderOutputV2 = z.infer<typeof ReaderOutputV2Schema>;

/** A page the reader's turn saw (48 § 5.4), in order of appearance: opened by a fetch, or only listed by a search (`search` is that search's one-based number). */
export const ReadPageSchema = z.strictObject({
  url: z.string().min(1),
  title: z.string().nullable(),
  opened: z.boolean(),
  search: z.number().int().min(1).nullable(),
});
export type ReadPage = z.infer<typeof ReadPageSchema>;

/**
 * What the read step leaves on the run for the validation and the submission (`ResearchRun.found`; unit 58d): the
 * findings as the reader wrote them and the `https` addresses its tools saw, which `SOURCE_NOT_SEEN` is decided
 * against. The asker's own text, purged with the brief (40 § 8.3).
 */
export const ResearchFoundSchema = z.strictObject({
  findings: z.array(z.unknown()),
  pages: z.array(z.string()),
  /** The ordinals (one-based, the reader's order) the validation passed; absent until it ran. The submission takes these and no other. */
  valid: z.array(z.number().int().min(1)).optional(),
  /** How many findings beyond the third the validation dropped (A13); absent until it ran. */
  dropped: z.number().int().nonnegative().optional(),
  /** A person's run (feature-specs/48 § 5.4): the version 2 reader's notes as it wrote them, until the validation replaces them with `says`. */
  notes: z.array(z.unknown()).optional(),
  /** A person's run: every page the turn saw, in order (48 § 5.4). */
  read: z.array(ReadPageSchema).optional(),
  /** A person's run: the notes that passed the checks (48 § 5.5), what the writer reads; set with `notes` removed. */
  says: z.array(ReaderNoteSchema).optional(),
  /** A person's run: how many notes the validation dropped (48 § 5.5). */
  notesDropped: z.number().int().nonnegative().optional(),
});
export type ResearchFound = z.infer<typeof ResearchFoundSchema>;

/* ---------------------------------------------------------------- a person's run: its steps and its report (feature-specs/48) */

/** The guide a person's run is planned, read and written under (48 § 5.3; `guides/researcher/v2.0`), which the Research page's header names. */
export const RESEARCHER_GUIDE_VERSION = "v2.0";

/** The kinds of a run's live steps (48 § 6), in the order a run meets them. */
export const RESEARCH_STEP_KINDS = ["PLANNING", "SECTIONS", "SEARCH", "PAGE", "CHECKING", "WRITING"] as const;
export type ResearchStepKind = (typeof RESEARCH_STEP_KINDS)[number];

const StepBase = { seq: z.number().int().nonnegative(), at: z.iso.datetime() };

/**
 * One live step of a person's run (48 § 6), written by the activity on the run's row as it happens and never part of the
 * workflow's history (invariant 35). A search is written when its call completes, with `results` null, and completed
 * when its result arrives; a page likewise with `opened` null, then `true` with the address opened and its title, or
 * `false` when it could not be reached. The query and the addresses are model and web text, which is why this lives
 * here and not in research.ts.
 */
export const ResearchStepSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...StepBase, kind: z.literal("PLANNING") }),
  z.strictObject({ ...StepBase, kind: z.literal("SECTIONS"), sections: z.array(SectionIdSchema).min(1).max(FINDINGS_MAX) }),
  z.strictObject({ ...StepBase, kind: z.literal("SEARCH"), query: z.string().min(1), results: z.number().int().nonnegative().nullable() }),
  z.strictObject({ ...StepBase, kind: z.literal("PAGE"), url: z.string().min(1), title: z.string().nullable(), opened: z.boolean().nullable() }),
  z.strictObject({ ...StepBase, kind: z.literal("CHECKING") }),
  z.strictObject({ ...StepBase, kind: z.literal("WRITING") }),
]);
export type ResearchStep = z.infer<typeof ResearchStepSchema>;

export const ResearchStepsSchema = z.array(ResearchStepSchema);
export type ResearchSteps = z.infer<typeof ResearchStepsSchema>;

/** The report's limits (48 § 5.6, D1): at most eight paragraphs and 600 words in all. */
export const REPORT_PARAGRAPHS_MAX = 8;
export const REPORT_WORDS_MAX = 600;

/** A paragraph of the report (48 § 5.6): its text, and the sections and the numbered pages it cites; at least one of either, held by the report sensor. */
export const ReportParagraphSchema = z.strictObject({
  text: TextSchema,
  sections: z.array(SectionIdSchema),
  pages: z.array(z.number().int().min(1)),
});
export type ReportParagraph = z.infer<typeof ReportParagraphSchema>;

/** The writer's answer as the guide asks for it (48 § 5.6): strict, at most eight paragraphs; the report sensor then checks each (§ 5.7). */
export const WriterOutputSchema = z.strictObject({ paragraphs: z.array(ReportParagraphSchema).min(1).max(REPORT_PARAGRAPHS_MAX) });
export type WriterOutput = z.infer<typeof WriterOutputSchema>;

/** Why the report sensor drops a paragraph (48 § 5.7), counted by rule in `report.dropped`. */
export const REPORT_DROP_RULES = ["SECTION", "PAGE", "NO_REFERENCE", "ADDRESS", "SECRET", "OT", "WORDS"] as const;
export type ReportDropRule = (typeof REPORT_DROP_RULES)[number];

/** The report as a run stores it (`ResearchRun.report`, 48 § 5.7): the paragraphs that passed, and how many were dropped by each rule. Purged with the text. */
export const ReportSchema = z.strictObject({
  paragraphs: z.array(ReportParagraphSchema).min(1).max(REPORT_PARAGRAPHS_MAX),
  dropped: z.partialRecord(z.enum(REPORT_DROP_RULES), z.number().int().min(1)),
});
export type Report = z.infer<typeof ReportSchema>;

