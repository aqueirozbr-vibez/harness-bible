import { z } from "zod";

import { PrincipalSchema } from "@/lib/schemas/gateway";
import { ASSISTANT_MODES, REFUSAL_CAUSES } from "@/lib/schemas/golden";
import { FigureIdSchema, ReleaseIdSchema, SectionIdSchema } from "@/lib/schemas/ids";

/*
 * The assistant's contract (feature-specs/13 § 3; architecture § 6.1): what spec 15 hands the flow, what the model
 * is allowed to answer, and what the flow returns. Nothing downstream reads unparsed JSON — the model's output
 * passes `AssistantOutputSchema` and a parse failure is the one cap (§ 6).
 *
 * The mode and refusal-cause lists are `lib/schemas/golden.ts`'s, because the golden set labels questions with the
 * same words and two spellings of one list is how they drift apart.
 */

export const RefusalCauseSchema = z.enum(REFUSAL_CAUSES);
export type RefusalCause = z.infer<typeof RefusalCauseSchema>;

/**
 * The guide this release's assistant answers under (feature-specs/13 § 7). It lives with the contract rather than
 * with the flow because both sides read it: the workers load the guide's files by it, and the dock's header names
 * it before the first answer's `meta` does (spec 16 § 5.2).
 */
export const ASSISTANT_GUIDE_VERSION = "v1.13";

export const ModeSchema = z.enum(ASSISTANT_MODES);
export type Mode = z.infer<typeof ModeSchema>;

export const LocaleSchema = z.enum(["en", "pt"]);
export type Locale = z.infer<typeof LocaleSchema>;

/** The four causes as the reader sees them (`R-SCOPE-OT` → `R-SCOPE-OT`), and the section pointers each carries. */
export const REFUSAL_CODES: Readonly<Record<RefusalCause, string>> = {
  "R-SCOPE": "R-SCOPE",
  "R-SCOPE-OT": "R-SCOPE-OT",
  "R-RECOMPUTE": "R-RECOMPUTE",
  "R-UNVERIFIED": "R-UNVERIFIED",
};

/** A turn of this conversation as the assembler may read it; a purged turn is omitted by the caller, never blanked. */
export const ConversationTurnSchema = z
  .strictObject({
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    refusal: RefusalCauseSchema.nullable(),
  })
  .readonly();
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

/**
 * What a turn's mode works on (feature-specs/23 § 5.1). Since Assistant 2.0 this is not where the reader is: a
 * conversation has no chapter, and what a question is about is read from the question (`lib/sensors/references.ts`).
 * `chapter` and `section` are set by the server for the two modes that have a target, and are null in the rest.
 */
export const AnswerContextSchema = z
  .strictObject({
    /** walk: the aid's chapter; lab: the lab's chapter; null in explain, compare and brief. */
    chapter: z.number().int().min(0).max(40).nullable(),
    /** walk: the aid's own section; null otherwise. */
    section: SectionIdSchema.nullable(),
    /** compare mode (spec 19): two distinct verified chapters, the reader's pick. */
    chapters: z.tuple([z.number().int().min(0).max(40), z.number().int().min(0).max(40)]).readonly().optional(),
    /** lab mode (spec 19): the lab the reader picked. */
    labId: z.string().min(1).optional(),
  })
  .readonly();
export type AnswerContext = z.infer<typeof AnswerContextSchema>;

/**
 * What spec 15 hands the flow: already validated, already rate-limited, already budgeted by the gateway. The flow
 * knows no HTTP and no rows; it answers this and returns an `AnswerResult`.
 */
export const AnswerRequestSchema = z
  .strictObject({
    releaseId: ReleaseIdSchema,
    locale: LocaleSchema,
    mode: ModeSchema,
    context: AnswerContextSchema,
    question: z.string().min(1).max(800),
    conversation: z.array(ConversationTurnSchema).readonly(),
    /** walk mode (spec 18 § 4): the script's run as `aidResultForPrompt` shapes it — inputs, values by path, bars, headline, line per step; null in every other mode. */
    aidResult: z.unknown().nullable(),
    principal: PrincipalSchema,
    traceId: z.string().min(1),
  })
  .readonly();
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;

/**
 * One claim the model makes: a sentence and the section it cites, with the figure id when the sentence quotes a
 * figure. The citation rules cap a claim at 60 words; the guide states it and this enforces it, because a claim
 * that runs on is a claim that cites loosely.
 */
export const ClaimSchema = z
  .strictObject({
    text: z.string().min(1),
    sectionId: SectionIdSchema,
    /* A claim that quotes no figure may leave the key out; absent and null mean the same thing. Demanding the
       key spent the one repair pass on an answer that was already correct (measured against the stub, 2026-09-25). */
    figureId: FigureIdSchema.nullable().default(null),
  })
  .readonly();
export type Claim = z.infer<typeof ClaimSchema>;

/** The model's structured output (architecture § 6.1; the guide's own schema). */
export const AssistantOutputSchema = z
  .strictObject({
    claims: z.array(ClaimSchema).readonly(),
    /* An answer is claims *or* a refusal, so the model that made claims may leave both of these out. Absent and
       null mean the same thing, and spending the one repair pass on a missing `"refusal": null` would be a waste
       of a call the reader is waiting for. An unknown key is still refused: the envelope is the envelope. */
    refusal: z
      .strictObject({ cause: RefusalCauseSchema, pointers: z.array(SectionIdSchema).readonly() })
      .readonly()
      .nullable()
      .default(null),
    /** The walk's and the brief's shapes arrive with specs 18 and 19; `null` for every mode until then. */
    mode_result: z.unknown().nullable().default(null),
  })
  .readonly();
export type AssistantOutput = z.infer<typeof AssistantOutputSchema>;

/**
 * `derive` is the walk's own sensor (spec 18 § 4), first in a walk turn's verdicts and absent from every other mode;
 * `mode` is compare, lab and brief's (spec 19 § 5), after the citation row and absent from explain and walk.
 */
export const SENSORS = ["derive", "scope", "citation", "mode", "edition", "grader", "latency"] as const;
export const SensorSchema = z.enum(SENSORS);
export type Sensor = z.infer<typeof SensorSchema>;

export const VERDICTS = ["PASS", "FAIL", "WARN", "NA"] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

/** A sensor's answer: pure `(input) => SensorVerdict`, ordered by the flow, rendered by the dock (code-standards). */
export const SensorVerdictSchema = z
  .strictObject({
    sensor: SensorSchema,
    verdict: VerdictSchema,
    detail: z.string(),
    data: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).readonly(),
  })
  .readonly();
export type SensorVerdict = z.infer<typeof SensorVerdictSchema>;

/** A claim plus what the citation sensor found. A substituted claim keeps its text for the record, never for the screen. */
export const ResolvedClaimSchema = z
  .strictObject({
    text: z.string(),
    sectionId: SectionIdSchema,
    figureId: FigureIdSchema.nullable(),
    /** The figure's value as the release prints it, when the claim quoted one. */
    valueText: z.string().nullable(),
    found: z.boolean(),
    substituted: z.boolean(),
  })
  .readonly();
export type ResolvedClaim = z.infer<typeof ResolvedClaimSchema>;

export const CitationSchema = z
  .strictObject({
    sectionId: SectionIdSchema,
    figureId: FigureIdSchema.nullable(),
    version: z.string(),
    editionLang: z.enum(["EN", "PT"]),
  })
  .readonly();
export type Citation = z.infer<typeof CitationSchema>;

export const RefusalSchema = z
  .strictObject({
    cause: RefusalCauseSchema,
    code: z.string(),
    pointers: z.array(z.strictObject({ sectionId: SectionIdSchema, title: z.string() }).readonly()).readonly(),
    beforeRetrieval: z.boolean(),
  })
  .readonly();
export type Refusal = z.infer<typeof RefusalSchema>;

export const AnswerTimingsSchema = z
  .strictObject({
    scopeMs: z.number(),
    retrieveMs: z.number(),
    firstTokenMs: z.number().nullable(),
    draftMs: z.number(),
    sensorsMs: z.number(),
    graderMs: z.number(),
    totalMs: z.number(),
  })
  .readonly();
export type AnswerTimings = z.infer<typeof AnswerTimingsSchema>;

/** What the flow returns; spec 15 writes the rows from it and spec 16 renders it, both from the final event alone. */
export const AnswerResultSchema = z
  .strictObject({
    kind: z.enum(["answer", "refusal"]),
    refusal: RefusalSchema.nullable(),
    claims: z.array(ResolvedClaimSchema).readonly(),
    citations: z.array(CitationSchema).readonly(),
    verdicts: z.array(SensorVerdictSchema).readonly(),
    grounded: z.number().min(0).max(1).nullable(),
    repaired: z.boolean(),
    guide: z.strictObject({ version: z.string(), sha256: z.string() }).readonly(),
    modelId: z.string(),
    timings: AnswerTimingsSchema,
    usage: z.strictObject({ inputTokens: z.number().int(), outputTokens: z.number().int(), cacheReadTokens: z.number().int() }).readonly(),
    modeResult: z.unknown().nullable(),
    /**
     * What a turn hands over to research (feature-specs/40 § 4; unit 57b), and to nobody else: the model's own sentence
     * behind each claim that was replaced by "the book does not cover this", and the sections retrieval gave the model,
     * cited or not. Rows of the message, purged with its text; no endpoint's schema carries them (a contract test holds it).
     */
    uncovered: z.array(z.strictObject({ sectionId: z.string().nullable(), text: z.string() }).readonly()).readonly().optional(),
    retrievedSections: z.array(z.string()).readonly().optional(),
  })
  .readonly();
export type AnswerResult = z.infer<typeof AnswerResultSchema>;

/**
 * The walk's `mode_result` (feature-specs/18 § 4; the guide's citation rules): one explanation per step of the aid,
 * mirroring the fenced result's ordinals. The derive sensor holds each to the numbers the script wrote.
 */
export const WalkResultSchema = z
  .strictObject({
    steps: z.array(z.strictObject({ ordinal: z.number().int().positive(), explained: z.string().min(1).max(600) }).readonly()).min(1).readonly(),
  })
  .readonly();
export type WalkResult = z.infer<typeof WalkResultSchema>;

/**
 * What a walk turn's `final` event carries as `modeResult` and what its row stores for a reload (spec 18 § 6, D4):
 * the run and the values as the workers computed them (`lib/aids/turn.ts`), and the explanations after the sensor.
 */
export const WalkModeResultSchema = z
  .object({
    aidId: z.string().min(1),
    inputs: z.record(z.string(), z.number()),
    run: z.object({ exitCode: z.number().int().nullable(), timedOut: z.boolean(), ms: z.number().int().nonnegative() }),
    pricesVerifiedAt: z.string().nullable(),
    sameAsBook: z.boolean(),
    steps: z
      .array(
        z.object({
          ordinal: z.number().int().positive(),
          titleKey: z.string(),
          line: z.number().int().positive().nullable(),
          pricesFrom: z.string().nullable(),
          values: z.record(z.string(), z.unknown()),
          bars: z.array(z.object({ labelKey: z.string(), tone: z.enum(["ink", "ver"]), unit: z.string().nullable(), shown: z.number().nullable(), width: z.number() })).readonly(),
          headline: z
            .union([
              z.object({ kind: z.literal("value"), value: z.number(), unit: z.string().nullable() }),
              z.object({ kind: z.literal("ratio"), times: z.number() }),
              z.object({ kind: z.literal("pct"), percent: z.number() }),
            ])
            .nullable(),
          missing: z.array(z.string()).readonly(),
        }),
      )
      .readonly(),
    explanations: z.array(z.object({ ordinal: z.number().int().positive(), text: z.string(), withheld: z.boolean() })).readonly(),
  })
  .readonly();
export type WalkModeResult = z.infer<typeof WalkModeResultSchema>;

/**
 * The other three modes' results (feature-specs/19 § 5, D1): minimal, because the sides of a compare, a lab's figure
 * table and a brief's count are computed in code from the claims and the data. The model's structure is checked by
 * the parser and the mode sensor, never rendered as it came.
 */
export const CompareResultSchema = z.strictObject({ openPoint: z.string().max(240).nullable() }).readonly();
export type CompareResult = z.infer<typeof CompareResultSchema>;

export const LabResultSchema = z.strictObject({ reproduces: z.string().min(1).max(240), divergingMeans: z.string().max(240).nullable() }).readonly();
export type LabResult = z.infer<typeof LabResultSchema>;

export const BRIEF_STANCES = ["recommends", "conditional", "leaves-open"] as const;
export const BriefResultSchema = z
  .strictObject({ decision: z.string().min(1).max(120), stance: z.enum(BRIEF_STANCES), condition: z.string().max(240).nullable() })
  .readonly();
export type BriefResult = z.infer<typeof BriefResultSchema>;

/**
 * What a lab turn's `final` event carries and its row stores (spec 19 § 6.2): the model's two sentences and the run
 * as the workers computed it from the same pseudo-section input, so the screen and the model saw one thing.
 */
export const LabRunFigureSchema = z.object({
  figureId: FigureIdSchema,
  sectionId: SectionIdSchema,
  label: z.string(),
  key: z.string(),
  chapterValue: z.string(),
  runValue: z.union([z.number(), z.string()]).nullable(),
  verdict: z.enum(["match", "diverge", "missing"]),
  line: z.number().int(),
});
export const LabModeResultSchema = z
  .object({
    reproduces: z.string(),
    divergingMeans: z.string().nullable(),
    lab: z.object({
      labId: z.string(),
      number: z.number().int(),
      title: z.string(),
      verdict: z.string().nullable(),
      checkedAt: z.string().nullable(),
      expectedRuntimeS: z.number().nullable(),
      declaresModelCalls: z.boolean(),
      figures: z.array(LabRunFigureSchema).readonly(),
    }),
  })
  .readonly();
export type LabModeResult = z.infer<typeof LabModeResultSchema>;

/** The `mode_result` branch each shaped mode must satisfy; explain has none and the parser ignores what it carries. */
export const MODE_RESULT_SCHEMAS = { walk: WalkResultSchema, compare: CompareResultSchema, lab: LabResultSchema, brief: BriefResultSchema } as const;

/** The sentence a withheld explanation shows, server side and in the reader's language (spec 18 D2; `assistant.walk.withheld`). */
export const WITHHELD: Readonly<Record<Locale, string>> = {
  en: "The script's values are shown above; the explanation was withheld.",
  pt: "Os valores do script estão acima; a explicação foi retida.",
};

/** The substitution the citation sensor makes, server side and in the reader's language (invariant 14). */
export const NO_COVER: Readonly<Record<Locale, string>> = {
  en: "the book does not cover this",
  pt: "o livro não cobre isso",
};
