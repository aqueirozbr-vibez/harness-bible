import { z } from "zod";

import { EvidenceTierSchema, LangSchema } from "@/lib/schemas/domain";
import { ASSISTANT_MODES, REFUSAL_CAUSES } from "@/lib/schemas/golden";
import { FigureIdSchema, ReleaseIdSchema, SectionIdSchema, SourceRowIdSchema, SuggestionIdSchema } from "@/lib/schemas/ids";
import { CODE_PATTERN, PLANNER_REFUSALS, refusalCodeOf } from "@/lib/schemas/research";
import {
  AnchorKindSchema,
  ChangeClassSchema,
  ChangeKindSchema,
  CriterionSchema,
  CuratorActionSchema,
  CuratorReasonSchema,
  DeciderSchema,
  DecisionSchema,
  EvidenceKindSchema,
  PartSchema,
  SuggestionOriginSchema,
  SuggestionSensorSchema,
  takesWithdrawal,
  WITHDRAWABLE_STATES,
} from "@/lib/schemas/improve";

/*
 * The ledger's record kinds and their payloads (architecture § 4.3;
 * feature-specs/14 § 6; invariant 18). One schema per kind; `append`
 * validates a payload against its kind's schema before the transaction
 * opens. Free text never enters a payload: every such field is the text's
 * sha256 and its name ends in `Sha256`, so a reviewer sees it. The eight
 * kinds of Improve and the researcher have had their payloads since unit 46c
 * (feature-specs/29 § 5), and with them a rule for each record's own columns:
 * who may be its actor, and whether it names a suggestion (`recordIssue`). The
 * export file's two line shapes (spec § 5.2) are here too, so `verifyExport`
 * reads a trailer with the schema the `EXPORT` payload is written with.
 */

/** Mirrors the Prisma enum `LedgerKind` exactly (code-standards § TypeScript). */
export const LEDGER_KINDS = ["SUBMITTED", "GRADED", "SENSORS", "DECIDED", "CURATOR", "MERGED", "ANSWER", "EXPORT", "RESEARCH", "ENDORSED", "RETRACTED", "ERASED"] as const;
export const LedgerKindSchema = z.enum(LEDGER_KINDS);
export type LedgerKind = z.infer<typeof LedgerKindSchema>;

/** A sha256 as the ledger stores one: 64 lower-case hex characters, the form the migration's CHECK pins on the record hashes. */
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 as 64 lower-case hex characters");

/** An instant as the ledger writes one, `Date.prototype.toISOString`: UTC with millisecond precision, the form the hashed `createdAt` takes. */
export const IsoInstantSchema = z.iso.datetime({ precision: 3 });

/**
 * A record's `seq`, and the counts that follow it: a positive integer.
 *
 * `Int`, not `BigInt`, against code-standards § Data and storage's general rule for sequence numbers, and
 * deliberately (Andre, 2026-09-24, unit 38): `seq` is a member of the record's hashed form, which is RFC 8785
 * canonical JSON, and that form has one number type with no exact representation beyond 2^53. A `bigint` would
 * have to be hashed as a string, changing every hash in the chain to buy a range no ledger will reach.
 */
export const SeqSchema = z.number().int().min(1);

const NULL_CHARACTER = "\u0000";

/** One half of a surrogate pair with no partner. Code-unit semantics, so no `u` flag: the halves are what is matched. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type UnstorableReason = "null_character" | "lone_surrogate";

/**
 * Why PostgreSQL's `jsonb` would refuse this string, or `null` when it would store it (Andre, 2026-09-24,
 * unit 38). Both forms are valid JavaScript strings and valid JSON, so only the database refuses them, and it
 * refuses them inside `append`'s transaction as a raw driver error unless the payload schema catches them first.
 */
export function unstorableText(value: string): UnstorableReason | null {
  if (value.includes(NULL_CHARACTER)) return "null_character";
  return LONE_SURROGATE.test(value) ? "lone_surrogate" : null;
}

/** The first string in the payload that `jsonb` would refuse, with the path to it, or `null`. Keys are strings too. */
export function firstUnstorable(value: unknown, path = "$"): { readonly path: string; readonly reason: UnstorableReason } | null {
  if (typeof value === "string") {
    const reason = unstorableText(value);
    return reason === null ? null : { path, reason };
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = firstUnstorable(item, `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const keyReason = unstorableText(key);
      if (keyReason !== null) return { path: `${path}.${key}`, reason: keyReason };
      const found = firstUnstorable(item, `${path}.${key}`);
      if (found !== null) return found;
    }
  }
  return null;
}

/** A sensor's verdict (code-standards § Workers: `PASS | FAIL | WARN | NA` plus detail); spec 13's `SensorVerdict.verdict`. */
export const SENSOR_VERDICTS = ["PASS", "FAIL", "WARN", "NA"] as const;
export const SensorVerdictValueSchema = z.enum(SENSOR_VERDICTS);
export type SensorVerdictValue = z.infer<typeof SensorVerdictValueSchema>;

export const AnswerPayloadSchema = z.strictObject({
  messageId: z.uuid(),
  conversationId: z.uuid(),
  releaseId: ReleaseIdSchema,
  mode: z.enum(ASSISTANT_MODES),
  refusal: z.strictObject({ cause: z.enum(REFUSAL_CAUSES), beforeRetrieval: z.boolean() }).nullable(),
  citations: z.array(z.strictObject({ sectionId: SectionIdSchema, figureId: FigureIdSchema.nullable(), version: z.string(), editionLang: LangSchema })),
  claims: z.strictObject({ total: z.number().int(), substituted: z.number().int() }),
  verdicts: z.array(z.strictObject({ sensor: z.string(), verdict: SensorVerdictValueSchema })),
  grounded: z.number().min(0).max(1).nullable(),
  repaired: z.boolean(),
  guide: z.strictObject({ version: z.string(), sha256: Sha256Schema }),
  modelId: z.string(),
  promptSha256: Sha256Schema,
  /** The question's hash, never its text, so a purged conversation still matches its record. */
  questionSha256: Sha256Schema,
  answerSha256: Sha256Schema,
  timings: z.strictObject({ firstTokenMs: z.number().nullable(), totalMs: z.number() }),
  usage: z.strictObject({ inputTokens: z.number().int(), outputTokens: z.number().int(), cacheReadTokens: z.number().int() }),
  traceId: z.string(),
  /** A walk turn's run (feature-specs/18 § 4): the inputs and the shown values as hashes, because they are the reader's numbers. */
  aid: z.strictObject({ id: z.string(), inputsSha256: Sha256Schema, runMs: z.number().int().nonnegative(), exitCode: z.number().int().nullable(), valuesSha256: Sha256Schema }).optional(),
});
export type AnswerPayload = z.infer<typeof AnswerPayloadSchema>;
/** What a caller hands `append`: the ids before the schema brands them. */
export type AnswerPayloadInput = z.input<typeof AnswerPayloadSchema>;

/**
 * `messages` is a conversation's own `ANSWER` records, named by the conversation's id (feature-specs/17 § 6); `research`
 * a person's research conversation's own `RESEARCH` records, named by its id (feature-specs/48 § 11.10).
 */
export const EXPORT_SCOPE_KINDS = ["all", "suggestion", "chapter", "account", "messages", "research"] as const;

/** The scope as the export trailer records it (spec § 5.2): absent parts as `null`, the window's dates as ISO-8601 UTC strings. */
export const ExportScopeSchema = z
  .strictObject({
    kind: z.enum(EXPORT_SCOPE_KINDS),
    id: z.string().min(1).nullable(),
    from: IsoInstantSchema.nullable(),
    to: IsoInstantSchema.nullable(),
    /** The kinds an audit pack was narrowed to (38 § 3; unit 55b); absent on a file of every kind. */
    kinds: z.array(LedgerKindSchema).min(1).optional(),
  })
  .refine((scope) => (scope.kind === "all") === (scope.id === null), { message: "the all scope has no id; a suggestion, chapter, account, messages or research scope names one", path: ["id"] });
export type ExportScopePayload = z.infer<typeof ExportScopeSchema>;

export const ExportPayloadSchema = z.strictObject({
  scope: ExportScopeSchema,
  fromSeq: SeqSchema,
  toSeq: SeqSchema,
  records: SeqSchema,
  headHash: Sha256Schema,
  fileSha256: Sha256Schema,
  /** The `AuditExport` row this record is the record of (38 § 3; unit 55b); absent on a download's record. */
  exportId: z.uuid().optional(),
});
export type ExportPayload = z.infer<typeof ExportPayloadSchema>;
export type ExportPayloadInput = z.input<typeof ExportPayloadSchema>;

/** A record line of the export file: the hashed form plus `hash`; a filtered scope's line also carries the record's chain predecessor, `null` on the genesis record. */
export const ExportLineSchema = z.strictObject({
  seq: SeqSchema,
  kind: LedgerKindSchema,
  actor: z.string(),
  suggestionId: z.string().nullable(),
  chapterVersionId: z.string().nullable(),
  payload: z.json(),
  createdAt: IsoInstantSchema,
  prevHash: Sha256Schema,
  hash: Sha256Schema,
  predecessor: z.strictObject({ seq: SeqSchema, hash: Sha256Schema }).nullable().optional(),
});
export type ExportLine = z.infer<typeof ExportLineSchema>;

/** The trailer: signed over its canonical form without `signature`, an Ed25519 signature as 128 lower-case hex characters. */
export const ExportTrailerSchema = z.strictObject({
  headHash: Sha256Schema,
  fromSeq: SeqSchema,
  toSeq: SeqSchema,
  records: SeqSchema,
  scope: ExportScopeSchema,
  exportedAt: IsoInstantSchema,
  signature: z.string().regex(/^[0-9a-f]{128}$/, "an Ed25519 signature as 128 lower-case hex characters"),
});
export type ExportTrailer = z.infer<typeof ExportTrailerSchema>;

/** The file's last line. */
export const ExportTrailerLineSchema = z.strictObject({ trailer: ExportTrailerSchema });

/* ---------------------------------------------------------------- Improve and the researcher (feature-specs/29 § 5) */

/*
 * The eight kinds below were named and empty until unit 46c. Each is a strict object: a key the schema does not
 * name is refused, so nothing can ride in under a name nobody reviewed. And no member of any of them can hold a
 * sentence: every piece of text a person or a model wrote is here as its sha256, and every other string has a form
 * (an id, an enumeration, a version, a host, a code). ledger.test.ts walks all eight with `freeTextIn` to hold
 * that, so a member added later is held to it too (invariant 18).
 */

/** `sha256(workflowId + ":" + step)`: what a retried activity looks for before it appends, so a record is written once (feature-specs/28 § 4.4). */
const StepKeySchema = Sha256Schema;

/** A guide's or the rubric's version: `v1.2`, `v2.1`, `v1.12`. */
const VersionSchema = z.string().regex(/^v\d+\.\d+$/, "a version like v1.2");

/** A chapter's version, as the book writes it: `v1.3.2`. */
const ChapterVersionNameSchema = z.string().regex(/^v\d+\.\d+\.\d+$/, "a chapter version like v1.3.2");

/** A W3C trace id: 32 lower-case hex characters (lib/api/trace.ts). */
const TraceIdSchema = z.string().regex(/^[0-9a-f]{32}$/, "a trace id as 32 lower-case hex characters");

/** A model's id or alias as the gateway reports it, or the name of a rule that stood in for one (`intake-rules`): no space in it. */
const ModelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/, "a model id or alias");

/** A person as the ledger names one: `user:` and their id. Never a name or an e-mail (architecture § 4.4). */
export const PseudonymSchema = z.templateLiteral(["user:", z.uuid()]);

/** A host name, lower-case: what an evidence item's address was fetched from. */
export const HostSchema = z.string().regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/, "a host name");

/** A DOI: `10.`, a registrant, a slash and a suffix with no space in it. */
/** A DOI in its bare form, as `lib/improve/doi.ts` `normaliseDoi` writes it: lowercase, no resolver, no `doi:`. The fetcher's DOI opener is held to it. */
export const DoiSchema = z.string().regex(/^10\.\d{4,9}\/[!-~]+$/, "a DOI like 10.1000/182");

/** What the fetcher found (feature-specs/32 § 4.4): a status, a cause or a type, each a code and never a sentence. The fetcher (`workers/fetch/`) is held to it by its test. */
export const FetchStatusSchema = z.string().regex(/^(?:opened:\d{3}|not_supplied|unreachable:[a-z0-9_]+|unsupported:[a-z0-9][a-z0-9.+/-]*)$/, "opened:<status>, unreachable:<cause>, unsupported:<type> or not_supplied");

/** A multiplier of the rubric (feature-specs/30 § 3.2): never above one. */
const FactorSchema = z.number().min(0).max(1);

const CountSchema = z.number().int().nonnegative();

const UsageSchema = z.strictObject({ inputTokens: CountSchema, outputTokens: CountSchema, cacheReadTokens: CountSchema });

const GuideSchema = z.strictObject({ version: VersionSchema, sha256: Sha256Schema });

/** What the six records of a suggestion all carry. */
const ofASuggestion = { stepKey: StepKeySchema, rubricVersion: VersionSchema, origin: SuggestionOriginSchema };

/**
 * `submitted`: what was proposed and against what, with the proposal and the rationale as hashes. `verified` is
 * the contributor's own, and null for a researcher's proposal, which has no contributor.
 */
export const SubmittedPayloadSchema = z
  .strictObject({
    ...ofASuggestion,
    releaseId: ReleaseIdSchema,
    changeKind: ChangeKindSchema,
    changeClass: ChangeClassSchema,
    curatorReason: CuratorReasonSchema.nullable(),
    anchor: z.strictObject({
      kind: AnchorKindSchema,
      section: SectionIdSchema,
      figure: FigureIdSchema.nullable(),
      sourceRow: SourceRowIdSchema.nullable(),
      chapterVersionId: z.uuid(),
      contentSha256: Sha256Schema,
      existsAtVersion: z.boolean(),
    }),
    proposalSha256: Sha256Schema,
    proposalKey: Sha256Schema,
    rationaleSha256: Sha256Schema.nullable(),
    rationaleWords: CountSchema,
    evidence: z.array(z.strictObject({ id: z.uuid(), kind: EvidenceKindSchema, host: HostSchema.nullable(), doi: DoiSchema.nullable() })),
    verified: z.boolean().nullable(),
  })
  .refine((payload) => (payload.changeClass === "CURATOR_ALWAYS") === (payload.curatorReason !== null), { message: "the curator's reason goes with the class CURATOR_ALWAYS and with no other", path: ["curatorReason"] })
  .refine((payload) => (payload.anchor.kind === "FIGURE") === (payload.anchor.figure !== null) && (payload.anchor.kind === "SOURCE_ROW") === (payload.anchor.sourceRow !== null), {
    message: "an anchor names the one figure or the one source row its kind says, beside its section",
    path: ["anchor", "kind"],
  })
  .refine((payload) => (payload.origin === "RESEARCHER") === (payload.verified === null), { message: "verified is the contributor's: a person's suggestion says it, a researcher's has none", path: ["verified"] });
export type SubmittedPayloadInput = z.input<typeof SubmittedPayloadSchema>;

/**
 * `graded`: every item with its tier, the three factors and the adjusted score, the hash of the text that was
 * graded and of the grader's reason; then the suggestion's score and which items made it (feature-specs/30 § 3.3).
 * An item that could not be opened has no factors and no text.
 */
export const GradedPayloadSchema = z.strictObject({
  ...ofASuggestion,
  items: z.array(
    z.strictObject({
      id: z.uuid(),
      kind: EvidenceKindSchema,
      fetchStatus: FetchStatusSchema,
      tier: EvidenceTierSchema,
      base: z.number().int().min(0).max(100),
      relevance: FactorSchema.nullable(),
      recency: FactorSchema.nullable(),
      independence: FactorSchema.nullable(),
      adjusted: z.number().int().min(0).max(100),
      gradedBy: ModelIdSchema,
      reasonSha256: Sha256Schema,
      contentSha256: Sha256Schema.nullable(),
    }),
  ),
  score: CountSchema,
  strongestItemId: z.uuid().nullable(),
  corroboratedById: z.uuid().nullable(),
  usage: UsageSchema,
  traceId: TraceIdSchema,
});
export type GradedPayloadInput = z.input<typeof GradedPayloadSchema>;

/** `sensors`: the verdicts that exist by then, the parts the change reaches, and one hash over the sensors' details. */
export const SensorsPayloadSchema = z.strictObject({
  ...ofASuggestion,
  verdicts: z.array(z.strictObject({ sensor: SuggestionSensorSchema, result: SensorVerdictValueSchema })),
  parts: z.array(PartSchema).min(1),
  detailSha256: Sha256Schema,
});
export type SensorsPayloadInput = z.input<typeof SensorsPayloadSchema>;

/**
 * A criterion's verdict in the record: a value (`C`, `0.8`, `+10`, `66<70`), not a phrase. No space in it, so that
 * the one member of this payload a model has a hand in cannot carry a sentence; its reason is here as a hash.
 */
export const CriterionVerdictValueSchema = z.string().regex(/^[A-Za-z0-9._:<>=+%-]{1,32}$/, "a value of at most 32 characters with no space");

/**
 * `decided`: the decision, who made it, the score against the thresholds, one line per criterion at most, and for
 * the adjudicator its guide, model and prompt. A decision by rule has none of those three and no tokens. The
 * adjudicator's failure (`CURATOR_REVIEW`, unit 50e) has what it had when it failed: a guide that loaded, a prompt
 * that was built, a model that answered.
 */
export const DecidedPayloadSchema = z
  .strictObject({
    ...ofASuggestion,
    decision: DecisionSchema,
    decidedBy: DeciderSchema,
    score: CountSchema,
    acceptAt: CountSchema.nullable(),
    floorAt: CountSchema.nullable(),
    sufficientTier: EvidenceTierSchema.nullable(),
    failingSensor: SuggestionSensorSchema.nullable(),
    criteria: z.array(z.strictObject({ name: CriterionSchema, verdict: CriterionVerdictValueSchema, reasonSha256: Sha256Schema })),
    guide: GuideSchema.nullable(),
    modelId: ModelIdSchema.nullable(),
    promptSha256: Sha256Schema.nullable(),
    usage: UsageSchema,
    traceId: TraceIdSchema,
  })
  .refine((payload) => new Set(payload.criteria.map((line) => line.name)).size === payload.criteria.length, { message: "a criterion has one line", path: ["criteria"] })
  .refine(
    (payload) => {
      const members = [payload.guide, payload.modelId, payload.promptSha256];
      if (payload.decidedBy !== "adjudicator") return members.every((member) => member === null);
      return payload.decision === "CURATOR_REVIEW" || members.every((member) => member !== null);
    },
    { message: "the guide, the model and the prompt are the adjudicator's: all three with its decision, what it had with its failure, none with a rule's", path: ["decidedBy"] },
  );
export type DecidedPayloadInput = z.input<typeof DecidedPayloadSchema>;

/** A curator's coded reason for accepting against the adjudicator: `OV-IND-02` (feature-specs/36 § 5.2). */
const OverrideCodeSchema = z.string().regex(/^OV-[A-Z]{3}-\d{2}$/, "an override code like OV-IND-02");

/** `curator`: what a curator did, with the note as a hash. The curator is the record's actor. */
export const CuratorPayloadSchema = z.strictObject({
  ...ofASuggestion,
  action: CuratorActionSchema,
  overrideCode: OverrideCodeSchema.nullable(),
  criterion: CriterionSchema.nullable(),
  noteSha256: Sha256Schema.nullable(),
  seeded: z.boolean(),
  seedMatched: z.boolean().nullable(),
  queueWaitMs: CountSchema,
  part: PartSchema,
});
export type CuratorPayloadInput = z.input<typeof CuratorPayloadSchema>;

/** The branch a change is made on (feature-specs/37 § 4.1): `improve/`, the suggestion's id, and a slug in lower-case ASCII. */
const BranchSchema = z.string().regex(/^improve\/S-\d{2}-\d{4,}-[a-z0-9]+(?:-[a-z0-9]+)*$/, "a branch like improve/S-36-0198-date-36-3");

/** A commit of the book's repository: 40 hex characters, or 64 in a repository of the newer format. */
const CommitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "a commit sha");

/** One half of the chapter's check (feature-specs/37 § 4.4), in that section's own words: it passed, it failed, there was no runner to run it, or the chapter has none. */
export const MERGE_CHECKS = ["PASS", "FAIL", "NOT_RUN", "NONE"] as const;

/** `merged`: where the change went and what it became. The people in it are pseudonyms; a researcher's proposal has no contributor. Written by the merge (unit 54c), on the chapter's new version. */
export const MergedPayloadSchema = z.strictObject({
  ...ofASuggestion,
  branch: BranchSchema,
  commitSha: CommitShaSchema,
  versionFrom: ChapterVersionNameSchema,
  versionTo: ChapterVersionNameSchema,
  bump: z.enum(["patch", "minor", "major"]),
  releaseFrom: ReleaseIdSchema,
  releaseTo: ReleaseIdSchema,
  renderHash: Sha256Schema,
  check: z.strictObject({ lab: z.enum(MERGE_CHECKS), lint: z.enum(MERGE_CHECKS) }),
  contributor: PseudonymSchema.nullable(),
  endorsedBy: PseudonymSchema.nullable(),
  mergedBy: PseudonymSchema,
  /** The suggestion this one reverts, when it is a revert. */
  reverts: SuggestionIdSchema.nullable(),
});
export type MergedPayloadInput = z.input<typeof MergedPayloadSchema>;

/**
 * What became of a research finding (feature-specs/40 § 3). A person's run's record (feature-specs/48 § 15) carries
 * `INVALID` and `VALID` only: what the person later does with a finding is the draft's or the proposal's own record.
 */
export const FINDING_OUTCOMES = ["INVALID", "DUPLICATE", "SUBMITTED", "REFUTED", "PROPOSED", "VALID", "DRAFTED"] as const;

/**
 * How a run ended (feature-specs/44 § 4; unit 61a): `DONE`, or `SKIPPED` or `FAILED` with the skip's or the failure's
 * code — a code, never a message. The research series count runs by it; a record written before unit 61 has none.
 */
export const ResearchEndSchema = z
  .strictObject({ state: z.enum(["DONE", "SKIPPED", "FAILED", "REFUSED"]), code: z.string().regex(CODE_PATTERN, "a code in capitals").nullable() })
  .refine((end) => (end.state === "DONE") === (end.code === null), { message: "a run that ended DONE has no code, and a skip, a failure or a refusal has one", path: ["code"] });

/**
 * `research` (feature-specs/40 § 6.3): that a run happened and what came of it. It names no suggestion, no message
 * and no reader; who asked is in the asker's own rows and nowhere else. A run whose planner found nothing to
 * research has no brief and no reader; one whose planner was called and failed, or whose brief the brief sensor
 * refused, planned `failed` — the call was made and charged, so the ledger says research ran (review of units 57–58).
 */
export const ResearchPayloadSchema = z
  .strictObject({
    stepKey: StepKeySchema,
    runId: z.uuid(),
    releaseId: ReleaseIdSchema,
    sections: z.array(SectionIdSchema),
    gap: z.boolean(),
    /** `refused`: a person's run the planner refused (feature-specs/48 § 15), with its cause in `refusal`. */
    planned: z.enum(["brief", "nothing", "failed", "refused"]),
    briefSha256: Sha256Schema.nullable(),
    searches: CountSchema,
    pageReads: CountSchema,
    findings: z.array(z.strictObject({ ordinal: SeqSchema, outcome: z.enum(FINDING_OUTCOMES) })),
    guide: GuideSchema,
    /** `writer`: a person's run's third call (feature-specs/48 § 5.6), null where it was not reached. */
    models: z.strictObject({ planner: ModelIdSchema, reader: ModelIdSchema.nullable(), writer: ModelIdSchema.nullable().optional() }),
    usage: UsageSchema,
    traceId: TraceIdSchema,
    end: ResearchEndSchema.optional(),
    /* A person's run (feature-specs/48 § 15): its conversation; the sha256 of the normalised question, the same hash as
       the run's own column, which is not the ANSWER record's hash of the question as stored; the report's hash; and the
       planner's refusal, its cause with the hyphens an enum member keeps. A legacy record has none of them. */
    /* null for a run its conversation's delete detached before it concluded (48 § 17.2): it is still owed its record */
    conversationId: z.uuid().nullable().optional(),
    questionSha256: Sha256Schema.optional(),
    reportSha256: Sha256Schema.nullable().optional(),
    refusal: z.enum(PLANNER_REFUSALS).nullable().optional(),
  })
  .refine((payload) => [payload.briefSha256, payload.models.reader].every((member) => (member !== null) === (payload.planned === "brief")), {
    message: "a brief and a reader go with a run that planned one, and with no other",
    path: ["planned"],
  })
  .refine((payload) => payload.refusal === undefined || (payload.refusal !== null) === (payload.planned === "refused"), {
    message: "a refusal goes with a run the planner refused, and with no other",
    path: ["refusal"],
  })
  .refine((payload) => payload.end?.state !== "REFUSED" || (payload.refusal != null && payload.end.code === refusalCodeOf(payload.refusal)), {
    message: "a refused run's code is its refusal's, with underscores",
    path: ["end"],
  })
  .refine((payload) => payload.planned !== "refused" || (payload.refusal != null && (payload.end === undefined || payload.end.state === "REFUSED")), {
    message: "a run the planner refused names its refusal and ended refused",
    path: ["planned"],
  });
export type ResearchPayloadInput = z.input<typeof ResearchPayloadSchema>;

/**
 * `endorsed` (feature-specs/42 § 6): a reader put their name to a research proposal, with the instant they
 * consented; or took it back, which is a second record with `withdrawn` true. The reader is the record's actor.
 */
export const EndorsedPayloadSchema = z.strictObject({ stepKey: StepKeySchema, consentAt: IsoInstantSchema, withdrawn: z.boolean() });
export type EndorsedPayloadInput = z.input<typeof EndorsedPayloadSchema>;

/**
 * `retracted` (feature-specs/45 § 5.3; unit 63c): a contributor withdrew their own suggestion where its workflow waited
 * for a person — from where, and under which decision. The contributor is the record's actor. Only a person's
 * suggestion is withdrawn; it closes with this record and nothing of it is deleted.
 */
export const RetractedPayloadSchema = z
  .strictObject({ ...ofASuggestion, from: z.enum(WITHDRAWABLE_STATES), outcome: DecisionSchema.nullable() })
  .refine((payload) => payload.origin === "HUMAN", { message: "only a person's suggestion is withdrawn", path: ["origin"] })
  .refine((payload) => takesWithdrawal(payload.from, payload.outcome), { message: "a suggestion is withdrawn from a curator's queue, or from where it takes a revision", path: ["from"] });
export type RetractedPayloadInput = z.input<typeof RetractedPayloadSchema>;

/**
 * `erased` (feature-specs/45 § 3.7, D2; unit 62d): a reader deleted a conversation, its rows with it. The reader is the
 * record's actor, and it names no suggestion and no chapter version. The conversation's id is in each of its `ANSWER`
 * records already, so the record adds no fact about the reader: it says why those records point at nothing. Its step
 * key is `erasedStepKeyOf(id)` (lib/db/ledger.ts), one a conversation. Since unit 68 a person's research conversation's
 * delete too (feature-specs/48 § 15): scope `research`, its step key `researchErasedStepKeyOf(id)`, which is
 * `stepKeyOf("research:<id>", "erased")` and so never a conversation's.
 */
export const ErasedPayloadSchema = z.strictObject({ stepKey: StepKeySchema, scope: z.strictObject({ kind: z.enum(["conversation", "research"]), id: z.uuid() }) });
export type ErasedPayloadInput = z.input<typeof ErasedPayloadSchema>;

/**
 * The discriminated union on `kind`: a kind paired with its payload, because
 * a payload does not repeat the kind the record's own column carries.
 */
export const LedgerPayloadSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("ANSWER"), payload: AnswerPayloadSchema }),
    z.strictObject({ kind: z.literal("EXPORT"), payload: ExportPayloadSchema }),
    z.strictObject({ kind: z.literal("SUBMITTED"), payload: SubmittedPayloadSchema }),
    z.strictObject({ kind: z.literal("GRADED"), payload: GradedPayloadSchema }),
    z.strictObject({ kind: z.literal("SENSORS"), payload: SensorsPayloadSchema }),
    z.strictObject({ kind: z.literal("DECIDED"), payload: DecidedPayloadSchema }),
    z.strictObject({ kind: z.literal("CURATOR"), payload: CuratorPayloadSchema }),
    z.strictObject({ kind: z.literal("MERGED"), payload: MergedPayloadSchema }),
    z.strictObject({ kind: z.literal("RESEARCH"), payload: ResearchPayloadSchema }),
    z.strictObject({ kind: z.literal("ENDORSED"), payload: EndorsedPayloadSchema }),
    z.strictObject({ kind: z.literal("RETRACTED"), payload: RetractedPayloadSchema }),
    z.strictObject({ kind: z.literal("ERASED"), payload: ErasedPayloadSchema }),
  ])
  /* A string PostgreSQL's jsonb refuses fails here, as `LEDGER_PAYLOAD` before the transaction, rather than as a
   * raw driver error inside it after the head lock is held (spec § 6; Andre, 2026-09-24, unit 38). */
  .check((ctx) => {
    const found = firstUnstorable(ctx.value.payload, "$.payload");
    if (found === null) return;
    const what = found.reason === "null_character" ? "a null character (U+0000)" : "an unpaired surrogate";
    ctx.issues.push({ code: "custom", input: ctx.value, path: ["payload"], message: `${found.path} carries ${what}, which PostgreSQL's jsonb cannot store` });
  });
export type LedgerPayload = z.infer<typeof LedgerPayloadSchema>;
export type LedgerPayloadInput = z.input<typeof LedgerPayloadSchema>;


/* ---------------------------------------------------------------- a record's own columns */

type ActorRule = "user" | "service:intake" | "service:grader" | "service:adjudicator" | "service:researcher" | "service:merge";

/**
 * Who may be the actor of each improvement kind, and what its record is about (feature-specs/29 § 5). A record of a
 * suggestion names the suggestion and the chapter version, which is what makes the per-suggestion and per-chapter
 * views work for it; a research record names neither, nor does a reader's deletion of a conversation (45 § 3.7).
 * `ANSWER` and `EXPORT` have no entry: their columns are as unit 28 left them.
 */
const RECORD_RULES: Readonly<Partial<Record<LedgerKind, { readonly actors: ReadonlyArray<ActorRule>; readonly about: "suggestion" | "nothing" }>>> = {
  SUBMITTED: { actors: ["user", "service:researcher"], about: "suggestion" },
  GRADED: { actors: ["service:grader"], about: "suggestion" },
  SENSORS: { actors: ["service:intake"], about: "suggestion" },
  DECIDED: { actors: ["service:intake", "service:adjudicator"], about: "suggestion" },
  CURATOR: { actors: ["user"], about: "suggestion" },
  MERGED: { actors: ["service:merge"], about: "suggestion" },
  /* a legacy run's record is the researcher's; a person's run's is the person's, who asked for it and paid (feature-specs/48 § 15) */
  RESEARCH: { actors: ["service:researcher", "user"], about: "nothing" },
  ENDORSED: { actors: ["user"], about: "suggestion" },
  RETRACTED: { actors: ["user"], about: "suggestion" },
  ERASED: { actors: ["user"], about: "nothing" },
};

export interface RecordColumns {
  readonly kind: LedgerKind;
  readonly actor: string;
  readonly suggestionId: string | null;
  readonly chapterVersionId: string | null;
}

/**
 * What is wrong with a record's own columns for its kind, or null. A `decided` record signed by a person, or a
 * `curator` record signed by a service, is a forgery whatever its payload says, and a record of a suggestion that
 * names none is one no view would ever show. The message says what the kind needs and never repeats what it was given.
 */
export function recordIssue(record: RecordColumns): string | null {
  const rule = RECORD_RULES[record.kind];
  if (rule === undefined) return null;
  const allowed = rule.actors.some((actor) => (actor === "user" ? PseudonymSchema.safeParse(record.actor).success : record.actor === actor));
  if (!allowed) return `the actor of a ${record.kind} record is ${rule.actors.map((actor) => (actor === "user" ? "a person (user:<id>)" : actor)).join(" or ")}`;
  if (rule.about === "nothing") return record.suggestionId === null && record.chapterVersionId === null ? null : `a ${record.kind} record names no suggestion and no chapter version`;
  if (!SuggestionIdSchema.safeParse(record.suggestionId).success) return `a ${record.kind} record names its suggestion by id`;
  if (!z.uuid().safeParse(record.chapterVersionId).success) return `a ${record.kind} record names the chapter version it is about`;
  return null;
}
