import { z } from "zod";
import { ResearchRefusalSchema, ResearchSkipSchema, ResearchStartedSchema, ResearchStateSchema } from "@/lib/schemas/research";
import { ReportParagraphSchema, ResearchStepSchema } from "@/lib/schemas/researcher";

import { AnswerTimingsSchema, CitationSchema, RefusalSchema, ResolvedClaimSchema, SensorVerdictSchema } from "@/lib/schemas/assistant";
import { RoleSchema } from "@/lib/schemas/auth";
import { EvidenceTierSchema, SourceTierSchema } from "@/lib/schemas/domain";
import { HomeChapterTileSchema } from "@/lib/schemas/home";
import { ReleaseIdSchema, SectionIdSchema } from "@/lib/schemas/ids";
import { AnchorKindSchema, ChangeClassSchema, ChangeKindSchema, CuratorReasonSchema, PartSchema, SuggestionStateSchema } from "@/lib/schemas/improve";
import { NoteBodySchema } from "@/lib/schemas/marks";

/*
 * Request and response schemas of the Phase 1 endpoints (feature-specs/09 § 6.2,
 * § 9). The OpenAPI document is generated from these (`npm run api:openapi`).
 */

export const ErrorBodySchema = z.object({ code: z.string(), message: z.string(), detail: z.unknown().optional(), traceId: z.string() });

export const LangQuerySchema = z.object({ lang: z.enum(["en", "pt"]).default("en") });
export const SearchQuerySchema = z.looseObject({ lang: z.enum(["en", "pt"]).default("en") });

export const ChapterParamsSchema = z.object({ n: z.string().regex(/^\d{2}$/) });
export const SectionParamsSchema = z.object({ id: SectionIdSchema });
/** The bookmark and note routes are `[sectionId]` folders, so Next names the parameter `sectionId`. */
export const SectionIdParamsSchema = z.object({ sectionId: SectionIdSchema });
export const FigureParamsSchema = z.object({ id: z.string().regex(/^F-\d{2}-\d{2,3}$/) });
export const PathParamsSchema = z.object({ path: z.enum(["executive", "builder", "foundations"]) });
export const SessionParamsSchema = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) });

export const ReleaseCurrentSchema = z.object({
  id: ReleaseIdSchema,
  gitSha: z.string().regex(/^[0-9a-f]{8,40}$/),
  publishedAt: z.coerce.date(),
  chapters: z.number().int().nonnegative(),
  labs: z.number().int().nonnegative(),
});

export const ChaptersListSchema = z.object({ items: z.array(HomeChapterTileSchema), count: z.number().int().nonnegative(), ms: z.number().nonnegative() });

export const FigureDeriveSchema = z.object({
  id: z.string(),
  sectionId: SectionIdSchema,
  label: z.string(),
  valueText: z.string(),
  tier: z.enum([...SourceTierSchema.options, "SCENARIO"]),
  derive: z.object({ labId: z.string(), filePath: z.string(), line: z.number().int().positive(), key: z.string(), expression: z.string() }),
});

export const ProgressBodySchema = z.object({ sectionId: SectionIdSchema });
export const BookmarkResultSchema = z.object({ sectionId: SectionIdSchema, bookmarked: z.boolean() });
export const NoteBodyRequestSchema = z.object({ body: NoteBodySchema });
export const NoteResultSchema = z.object({ sectionId: SectionIdSchema, note: z.object({ body: z.string(), updatedAt: z.string() }).nullable() });
export const NoteDeleteResultSchema = z.object({ sectionId: SectionIdSchema, deleted: z.boolean() });

export const MeSchema = z.object({
  id: z.uuid(),
  email: z.string().email(),
  displayName: z.string(),
  role: RoleSchema,
  locale: z.enum(["en", "pt"]),
  createdAt: z.string(),
  organisation: z.object({ name: z.string() }).nullable(),
});

export const MeSessionSchema = z.object({ id: z.string(), current: z.boolean(), device: z.string(), createdAt: z.string(), lastSeenAt: z.string(), expiresAt: z.string() });
export const MeSessionsSchema = z.object({ items: z.array(MeSessionSchema), count: z.number().int().nonnegative(), ms: z.number().nonnegative() });
export const SessionRevokedSchema = z.object({ id: z.string(), revoked: z.boolean() });

/** Raw-response endpoints (redirects) declare this so the document says "no body". */
export const NoBodySchema = z.never();

/*
 * The assistant (feature-specs/15 § 5). Four endpoints: create a conversation, read it, ask in it (the stream,
 * declared with its events under `x-sse-events`), and flag a message. The reader's text is capped at the
 * composer's 800 characters here, at the boundary, so nothing longer reaches a prompt.
 */

/**
 * A conversation is opened with a language and nothing else (feature-specs/23 § 7.3): it belongs to the reader and
 * the current release, not to a chapter. A `chapter` or `section` an older client still sends is not read.
 */
export const ConversationCreateSchema = z.object({
  locale: z.enum(["en", "pt"]),
});

export const ConversationSchema = z.object({
  id: z.uuid(),
  releaseId: z.string(),
  locale: z.string(),
  createdAt: z.string(),
});

export const ConversationParamsSchema = z.object({ id: z.uuid() });
/** A conversation deleted (feature-specs/45 § 3.2): its id, and the `ERASED` record's place in the chain, null where the record could not be appended after the delete (§ 3.7). */
export const ConversationDeletedSchema = z.object({ id: z.uuid(), deleted: z.literal(true), ledgerSeq: z.number().int().positive().nullable() });
export type ConversationDeleted = z.infer<typeof ConversationDeletedSchema>;
export const MessageParamsSchema = z.object({ id: z.uuid() });

export const CitationViewSchema = z.object({
  ordinal: z.number().int(),
  sectionId: z.string(),
  figureId: z.string().nullable(),
  version: z.string(),
  editionLang: z.string(),
  claimText: z.string().nullable(),
  /** The cited figure's line in its lab's `derive.py`, for the `ƒ L45` mark; null when the figure is not derived or none is cited. */
  deriveLine: z.number().int().nullable(),
});

export const VerdictViewSchema = z.object({ sensor: z.string(), verdict: z.string(), detail: z.string() });

export const LedgerLineSchema = z.object({ seq: z.number().int(), hash: z.string() });

/**
 * A proposal a run made, as the reader who asked is shown it (feature-specs/43 § 5.3; unit 60b): the anchor with its
 * section's title, the class, the change before and after, each source's host, tier and adjusted score, the score
 * against the accept line, the researcher's note, where it stands, and the reader's own name on it. `lib/improve/
 * proposalView.ts` builds it; the panel under the answer, the landing page's list and the research endpoint carry it.
 * No field names the run, the message or the question. The record's link comes with the record's audience (60e).
 */
export const ProposalViewSchema = z.object({
  suggestionId: z.string().min(1),
  anchor: z.object({ kind: AnchorKindSchema, id: z.string(), section: z.string().nullable(), title: z.string().nullable() }).nullable(),
  changeKind: ChangeKindSchema,
  changeClass: ChangeClassSchema,
  curatorReason: CuratorReasonSchema.nullable(),
  change: z.object({ before: z.string().nullable(), after: z.string().nullable() }),
  /** The language of the anchored text and the change, the suggestion's edition. */
  contentLang: z.enum(["en", "pt"]),
  sources: z.array(z.object({ host: z.string().nullable(), tier: EvidenceTierSchema.nullable(), adjusted: z.number().nullable() })),
  score: z.number().int().nullable(),
  acceptAt: z.number().int().nullable(),
  note: z.string().nullable(),
  where: z.object({
    state: SuggestionStateSchema,
    parts: z.array(PartSchema),
    /** With a curator: the queue's deadline. */
    decisionBy: z.string().nullable(),
    /** Merged: the chapter version it is in. */
    version: z.string().nullable(),
    /** Closed: by a curator's decline, or by the chapter's check after a curator's accept. */
    closedBy: z.enum(["curator", "check"]).nullable(),
  }),
  endorsed: z.object({ byMe: z.literal(true), at: z.iso.datetime() }).nullable(),
});
export type ProposalView = z.infer<typeof ProposalViewSchema>;
/* The endorsement of a proposal (feature-specs/42 § 6; unit 59d): the asker's name on it, or none. */
export const ProposalParamsSchema = z.object({ suggestionId: z.string().regex(/^S-\d{2}-\d{4,}$/) });
export const EndorseBodySchema = z.strictObject({ consent: z.boolean() });
export const EndorsementSchema = z.object({ suggestionId: z.string().min(1), endorsed: z.object({ byMe: z.literal(true), at: z.iso.datetime() }).nullable() });
export type Endorsement = z.infer<typeof EndorsementSchema>;

/**
 * The run that follows an answer, as the line under it reads it (feature-specs/43 § 4.2, § 4.3): its state and skip,
 * the whole days since the sections or the question were researched (a skip's number), the budget's reset (an instant),
 * and its proposals. Answered by `GET /assistant/messages/{id}/research` and carried by a message read back from its
 * row, so a reload shows the same line. No field holds the question, the brief or a finding's text.
 */
export const ResearchViewSchema = z.object({
  state: ResearchStateSchema,
  skip: ResearchSkipSchema.nullable(),
  days: z.number().int().nonnegative().nullable(),
  resetsAt: z.string().nullable(),
  proposals: z.array(ProposalViewSchema),
});
export type ResearchView = z.infer<typeof ResearchViewSchema>;

export const MessageViewSchema = z.object({
  id: z.uuid(),
  role: z.enum(["USER", "ASSISTANT"]),
  ordinal: z.number().int(),
  mode: z.string(),
  text: z.string().nullable(),
  refusal: z.object({ cause: z.string(), beforeRetrieval: z.boolean() }).nullable(),
  citations: z.array(CitationViewSchema),
  verdicts: z.array(VerdictViewSchema),
  grounded: z.number().nullable(),
  repaired: z.boolean(),
  substituted: z.number().int(),
  citesEdition: z.string().nullable(),
  firstTokenMs: z.number().int().nullable(),
  totalMs: z.number().int().nullable(),
  ledger: LedgerLineSchema.nullable(),
  flag: z.object({ kind: z.string(), reason: z.string() }).nullable(),
  /** The turn's trace id: the record footer prints it, and support quotes it (feature-specs/16 § 5.7). */
  traceId: z.string(),
  /** A walk turn's run, values and explanations (`WalkModeResultSchema`), so a reload renders the walk; null on other turns. */
  modeResult: z.unknown().nullable(),
  /** The research run that followed an assistant message (43 § 4.3), whole, so a reload shows the line; null on a question, a refusal's row, or a turn from before research. */
  research: ResearchViewSchema.nullable(),
  createdAt: z.string(),
});

export const ConversationViewSchema = ConversationSchema.extend({
  textPurgedAt: z.string().nullable(),
  messages: z.array(MessageViewSchema),
});

/**
 * The composer's cap, enforced at the boundary so nothing longer ever reaches a prompt (§ 5.3). The endpoint
 * checks it rather than the schema, because the reader's client is told `TEXT_TOO_LONG` and not the generic code
 * a schema refusal carries; the pipeline's 64 KB body limit still bounds what is parsed at all.
 */
export const QUESTION_MAX = 800;

export const MessagePostSchema = z.object({
  text: z.string().trim().min(1).describe(`At most ${String(QUESTION_MAX)} characters; a longer question is 400 TEXT_TOO_LONG.`),
  mode: z.enum(["explain", "compare", "walk", "lab", "brief"]),
  /** What the turn's mode picked (feature-specs/23 § 7.3): compare's two chapters, lab mode's lab. Never where the reader is. */
  context: z
    .object({
      chapters: z.tuple([z.number().int().min(0).max(40), z.number().int().min(0).max(40)]).optional(),
      labId: z.string().min(1).optional(),
    })
    .optional(),
  /** walk mode (feature-specs/18 § 6): the aid and the reader's inputs, required together with `mode: "walk"`. The values are checked by the aid's own ranges, so a non-number is a 422 field error, not a schema refusal. */
  aidId: z.string().min(1).optional(),
  aidInputs: z.record(z.string(), z.unknown()).optional(),
});

export const FLAG_REASONS = ["wrong_citation", "missing_citation", "wrong_number", "should_not_refuse", "should_refuse", "other"] as const;

export const FlagPostSchema = z.object({ kind: z.enum(["answer", "refusal"]), reason: z.enum(FLAG_REASONS) });
export const FlagSchema = z.object({ id: z.uuid(), messageId: z.uuid(), kind: z.string(), reason: z.string(), createdAt: z.string() });

/**
 * The `final` event's data (§ 6.1, § 7): the whole of what the dock renders, and the only source of citations,
 * substitutions, refusals and verdicts (invariant 14). It is the flow's result with the row's id and ordinal, the
 * retrieval budget's flag, and the ledger line that proves the turn — the guide and the model id stay on the row
 * and in the record, because the reader's answer does not depend on them.
 */
export const SseFinalSchema = z.object({
  messageId: z.uuid(),
  ordinal: z.number().int(),
  kind: z.enum(["answer", "refusal"]),
  refusal: RefusalSchema.nullable(),
  claims: z.array(ResolvedClaimSchema),
  citations: z.array(CitationSchema),
  verdicts: z.array(SensorVerdictSchema),
  grounded: z.number().nullable(),
  repaired: z.boolean(),
  citesEdition: z.string().nullable(),
  timings: AnswerTimingsSchema,
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), cacheReadTokens: z.number().int() }),
  overBudget: z.boolean(),
  ledger: z.object({ seq: z.number().int(), hash: z.string(), prevHash: z.string().nullable() }),
  /** walk mode: the run, the values per step and the checked explanations (`WalkModeResultSchema`); null in every other mode. */
  modeResult: z.unknown().nullable(),
  /** The derive lines of the figures this answer cites (feature-specs/23 § 7.3); absent from a `final` stored before it. */
  derives: z.array(z.object({ figureId: z.string(), line: z.number().int() })).optional(),
  /**
   * The research run that followed the answer (feature-specs/40 § 6.1; unit 57d): its state, why it was skipped, its id.
   * Absent from a `final` stored before it, and from every `final` since unit 75, which hands no turn to research
   * (feature-specs/48 § 9.2); optional, so the stored finals of the turns between still parse when replayed.
   */
  research: ResearchStartedSchema.optional(),
});

/** The `meta` event: written once the reader's question is on the record, before a model is asked anything (§ 6.1). */
export const SseMetaSchema = z.object({
  messageId: z.uuid(),
  conversationId: z.uuid(),
  ordinal: z.number().int(),
  traceId: z.string(),
  mode: z.string(),
  guide: z.object({ version: z.string() }),
  alias: z.literal("hb-frontier"),
});

/** The `status` event: the dock's status line, one word per step of the flow (feature-specs/13 § 9). */
export const SseStatusSchema = z.object({ step: z.enum(["running", "retrieving", "drafting", "checking", "grading", "repairing"]).describe("`running` is the walk's script in its container, before any model is asked (feature-specs/18 § 5.2).") });

/** The `token` event: one delta of the draft. Never a citation, never a number the sensors have not seen. */
export const SseTokenSchema = z.object({ text: z.string() });

/** The `error` event: instead of `final` when the turn failed after `meta`; `resetsAt` only for the budget. */
export const SseErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  traceId: z.string(),
  resetsAt: z.string().optional(),
  /** `AID_RUN_FAILED` only: the run's exit code, timeout flag and duration, for the walk's failed run line (feature-specs/18 § 7). */
  detail: z.record(z.string(), z.unknown()).optional(),
});

/** The events of the assistant's stream, in the order they may arrive, for the document's `x-sse-events` (§ 7, D6). */
export const SSE_EVENTS = {
  meta: SseMetaSchema,
  status: SseStatusSchema,
  token: SseTokenSchema,
  final: SseFinalSchema,
  error: SseErrorSchema,
} as const;

/*
 * A person's research (feature-specs/48 § 13, § 16; unit 71): a conversation of runs, opened from scratch or seeded
 * from an Assistant answer of the person's, each run started by a question and followed by a poll of its view. No
 * answer of a write holds text or an address, so a stored idempotent response holds none (§ 17.2). What never reaches
 * a client is § 16's list: an `INVALID` finding and its reason, the reader's ordinals, the number checked, the brief,
 * the reader's notes on the pages, the seed's uncovered sentences, the agents' raw output and the dropped paragraphs, a
 * run's failure code, the workflow's id, and anything of another person (tests/research-contract.test.ts walks it).
 */

/** A research opened with a language, and with the Assistant answer it starts from where it has one (A6). */
export const ResearchConversationCreateSchema = z.object({
  locale: z.enum(["en", "pt"]),
  seedMessageId: z.uuid().optional(),
});

/** A research as it was opened: `seed` is the Assistant answer it was seeded from, by id, or null from scratch. */
export const ResearchConversationSchema = z.object({
  id: z.uuid(),
  locale: z.enum(["en", "pt"]),
  seed: z.uuid().nullable(),
  createdAt: z.string(),
});
export type ResearchConversation = z.infer<typeof ResearchConversationSchema>;

/** A run started (§ 5.2): the question at most `QUESTION_MAX` characters, which the endpoint checks so the client is told `TEXT_TOO_LONG`; the language it was asked in. */
export const ResearchRunPostSchema = z.object({
  question: z.string().trim().min(1).describe(`At most ${String(QUESTION_MAX)} characters; a longer question is 400 TEXT_TOO_LONG.`),
  language: z.enum(["en", "pt"]),
});

/** The start's answer, 202: the run's id and where it stands — queued with its workflow, or refused by a rule at no cost. */
export const ResearchRunStartedSchema = z.object({ runId: z.uuid(), state: z.enum(["QUEUED", "REFUSED"]) });
export type ResearchRunStarted = z.infer<typeof ResearchRunStartedSchema>;

/** A run's flag (§ 11.7): a report's or a refusal's, with a reason of the answers' list; one a run, no text. */
export const ResearchFlagPostSchema = z.object({ kind: z.enum(["report", "refusal"]), reason: z.enum(FLAG_REASONS) });
export const ResearchFlagSchema = z.object({ runId: z.uuid(), kind: z.enum(["report", "refusal"]), reason: z.enum(FLAG_REASONS), at: z.string() });
export type ResearchFlag = z.infer<typeof ResearchFlagSchema>;

/**
 * The run's line (§ 18): one key per row of its table, which the page renders from the catalogue with the mark's hue.
 * `done` and `donePurged` differ in what their detail counts (the pages read, or opened once the list was purged);
 * `abandoned` is a run the engine no longer moves, stale or ended `FAILED · ABANDONED`; `stopped` a run that met the
 * cap after it began, `notStarted` one whose planner met it.
 */
export const RESEARCH_RUN_LINE_KEYS = ["queued", "planning", "reading", "checking", "writing", "done", "donePurged", "refused", "notStarted", "stopped", "failed", "abandoned", "purged", "notRun"] as const;
export const ResearchRunLineSchema = z.object({ key: z.enum(RESEARCH_RUN_LINE_KEYS), tone: z.enum(["run", "ok", "warn", "mute"]) });
export type ResearchRunLine = z.infer<typeof ResearchRunLineSchema>;

/** What became of a finding that passed the checks, as the person is shown it (§ 8.1): `SENT` is a `SUBMITTED` finding with its suggestion. */
export const FINDING_USES = ["VALID", "DRAFTED", "SENT", "DUPLICATE", "PROPOSED", "REFUTED"] as const;

/**
 * A finding that passed the checks (§ 16), numbered 1 to the number that passed, never by the reader's ordinal. Its
 * anchor, change, class, sources and note are null once its run's text is purged; `use` stays, from the row.
 */
export const ResearchFindingViewSchema = z.object({
  id: z.uuid(),
  n: z.number().int().min(1),
  textPurged: z.boolean(),
  anchor: z.object({ kind: AnchorKindSchema, id: z.string(), section: z.string().nullable(), title: z.string().nullable() }).nullable(),
  changeKind: ChangeKindSchema.nullable(),
  changeClass: ChangeClassSchema.nullable(),
  curatorReason: CuratorReasonSchema.nullable(),
  change: z.object({ before: z.string().nullable(), after: z.string().nullable() }).nullable(),
  sources: z.array(z.object({ url: z.string(), host: z.string() })).nullable(),
  note: z.string().nullable(),
  /**
   * What became of it (§ 8.1): the suggestion's id where it is the person's to see (§ 8.5); the path it opens under the
   * page's own locale — a draft's edit page while a draft and its own page after, a visible duplicate's record — or
   * null; and the code a send failed with while it is unused (`FINDING_FAILURES`).
   */
  use: z.object({ state: z.enum(FINDING_USES), suggestionId: z.string().nullable(), href: z.string().nullable(), failure: z.string().nullable() }),
  proposal: ProposalViewSchema.nullable(),
});
export type ResearchFindingView = z.infer<typeof ResearchFindingViewSchema>;

/** A page the run read (§ 16), numbered as its report cites it. */
export const ResearchPageViewSchema = z.object({
  n: z.number().int().min(1),
  url: z.string(),
  host: z.string(),
  title: z.string().nullable(),
  opened: z.boolean(),
  search: z.number().int().min(1).nullable(),
});
export type ResearchPageView = z.infer<typeof ResearchPageViewSchema>;

/**
 * A run as the page shows it (§ 16): the run endpoint's answer, and each run of the conversation's view. The steps are
 * the run's live progress (§ 6); the report its paragraphs alone; the pages from the steps until the reader answered,
 * then the turn's own list; the refusal the Assistant's card (`RefusalView`), pointers with their titles.
 */
export const ResearchRunViewSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  ordinal: z.number().int().min(1),
  question: z.string().nullable(),
  language: z.enum(["en", "pt"]),
  seeded: z.boolean(),
  state: ResearchStateSchema,
  line: ResearchRunLineSchema,
  stale: z.boolean(),
  refusal: z
    .object({
      cause: ResearchRefusalSchema,
      code: z.string(),
      pointers: z.array(z.object({ sectionId: z.string(), title: z.string() })),
      beforeRetrieval: z.literal(true),
    })
    .nullable(),
  resetsAt: z.string().nullable(),
  steps: z.array(ResearchStepSchema),
  sections: z.array(z.object({ id: z.string(), title: z.string().nullable() })),
  report: z.object({ paragraphs: z.array(ReportParagraphSchema) }).nullable(),
  pages: z.array(ResearchPageViewSchema),
  findings: z.array(ResearchFindingViewSchema),
  usage: z.object({ searches: z.number().int().nonnegative(), pagesOpened: z.number().int().nonnegative(), pagesSeen: z.number().int().nonnegative().nullable(), costUsd: z.string().nullable() }),
  flag: z.object({ kind: z.enum(["report", "refusal"]), reason: z.string() }).nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  textPurged: z.boolean(),
});
export type ResearchRunView = z.infer<typeof ResearchRunViewSchema>;

/** A research with its runs' views, oldest first (§ 13). */
export const ResearchConversationViewSchema = ResearchConversationSchema.extend({
  textPurgedAt: z.string().nullable(),
  runs: z.array(ResearchRunViewSchema),
});
export type ResearchConversationView = z.infer<typeof ResearchConversationViewSchema>;

/*
 * A finding turned into an improvement (feature-specs/48 § 8, § 13; unit 74), one button a finding by role: a verified
 * contributor's draft of their own in Improve, or anyone else's send as a researcher's proposal. Neither answer holds an
 * address or a word of the finding, so a stored idempotent response holds none (§ 17.2).
 */

/** The draft's body: the page's language, the one its edit page is opened in. */
export const ResearchFindingDraftSchema = z.object({ locale: z.enum(["en", "pt"]) });

/** The draft made (§ 8.2 step 9), 201: the suggestion, its edit page, and how many of the finding's sources are its items, each grading. */
export const ResearchFindingDraftedSchema = z.object({
  suggestionId: z.string().regex(/^S-\d{2}-\d{4,}$/),
  href: z.string().regex(/^\/(?:en|pt)\/improve\/S-\d{2}-\d{4,}\/edit$/),
  items: z.number().int().nonnegative(),
});
export type ResearchFindingDrafted = z.infer<typeof ResearchFindingDraftedSchema>;

/** The send's body: nothing; the finding is the path's. */
export const ResearchFindingSendSchema = z.strictObject({});

/** The send started (§ 8.3 step 8), 202: the finding is being sent. `sending` is then the client's own state until its follow sees the finding move (§ 16). */
export const ResearchFindingSendingSchema = z.object({ findingId: z.uuid(), use: z.literal("SENDING") });
export type ResearchFindingSending = z.infer<typeof ResearchFindingSendingSchema>;
