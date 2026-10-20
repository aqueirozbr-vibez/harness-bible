import type { AppendInput } from "@/lib/ledger/append";
import type {
  AnswerPayloadInput,
  CuratorPayloadInput,
  DecidedPayloadInput,
  EndorsedPayloadInput,
  ErasedPayloadInput,
  ExportPayloadInput,
  GradedPayloadInput,
  MergedPayloadInput,
  ResearchPayloadInput,
  RetractedPayloadInput,
  SensorsPayloadInput,
  SubmittedPayloadInput,
} from "@/lib/schemas/ledger";

/*
 * Valid payloads for the ledger tests, built from the specs' named ids. The two of Phase 2 (feature-specs/14 § 6):
 * chapter 21's worked numbers, figure F-21-03, release 2026.09, guide v1.8. The eight of Improve and the
 * researcher (feature-specs/29 § 5): the PRD's fourth worked example as spec 33 § 8 tells it, suggestion
 * S-15-0377, a cited price in 15.9 with a tier C item from the vendor concerned (70 × 1.0 × 1.0 × 0.8 = 56) and a
 * tier D item five months old (60 × 1.0 × 0.7 × 1.0 = 42), score 66 against an accept of 70, request more, then a
 * curator's accept with OV-IND-02 and the patch from v1.3.2 to v1.3.3 the screens show. Every free-text field is a
 * hash, as the schemas require.
 */

/** A sha256-shaped string with a readable marker: `<marker>` padded to 64 hex characters. */
export function hexOf(marker: string): string {
  return marker.padEnd(64, "0");
}

export const ANSWER_PAYLOAD = {
  messageId: "00000000-0000-4000-8000-000000000001",
  conversationId: "00000000-0000-4000-8000-000000000002",
  releaseId: "2026.09",
  mode: "explain",
  refusal: null,
  citations: [
    { sectionId: "21.3", figureId: "F-21-03", version: "v1.5.0", editionLang: "EN" },
    { sectionId: "21.2", figureId: null, version: "v1.5.0", editionLang: "EN" },
  ],
  claims: { total: 4, substituted: 0 },
  verdicts: [
    { sensor: "citation", verdict: "PASS" },
    { sensor: "scope", verdict: "PASS" },
    { sensor: "grader", verdict: "PASS" },
    { sensor: "edition", verdict: "PASS" },
    { sensor: "latency", verdict: "NA" },
  ],
  grounded: 0.94,
  repaired: false,
  guide: { version: "v1.8", sha256: hexOf("a1de") },
  modelId: "hb-frontier",
  promptSha256: hexOf("b2c3"),
  questionSha256: hexOf("c3d4"),
  answerSha256: hexOf("d4e5"),
  timings: { firstTokenMs: 1300, totalMs: 4600 },
  usage: { inputTokens: 4210, outputTokens: 312, cacheReadTokens: 3900 },
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
} satisfies AnswerPayloadInput;

export const EXPORT_PAYLOAD = {
  scope: { kind: "chapter", id: "cv-21", from: null, to: null },
  fromSeq: 1,
  toSeq: 80,
  records: 80,
  headHash: hexOf("9b41d2e07a3c"),
  fileSha256: hexOf("f11e"),
} satisfies ExportPayloadInput;

/* ---------------------------------------------------------------- Improve and the researcher */

export const SUGGESTION_ID = "S-15-0377";
export const CHAPTER_VERSION_ID = "00000000-0000-4000-8000-000000001509";
export const CONTRIBUTOR = "user:00000000-0000-4000-8000-0000000046c1";
export const CURATOR = "user:00000000-0000-4000-8000-0000000046c2";
export const READER = "user:00000000-0000-4000-8000-0000000046c3";

const VENDOR_ITEM = "00000000-0000-4000-8000-00000000e001";
const ANALYST_ITEM = "00000000-0000-4000-8000-00000000e002";
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const ofTheSuggestion = { rubricVersion: "v1.2", origin: "HUMAN" } as const;

export const SUBMITTED_PAYLOAD = {
  stepKey: hexOf("5001"),
  ...ofTheSuggestion,
  releaseId: "2026.09",
  changeKind: "EDIT_ROW",
  changeClass: "CITED_FIGURE",
  curatorReason: null,
  anchor: { kind: "SOURCE_ROW", section: "15.9", figure: null, sourceRow: "15.9 r4", chapterVersionId: CHAPTER_VERSION_ID, contentSha256: hexOf("c0de"), existsAtVersion: true },
  proposalSha256: hexOf("b001"),
  proposalKey: hexOf("b002"),
  rationaleSha256: hexOf("b003"),
  rationaleWords: 41,
  evidence: [
    { id: VENDOR_ITEM, kind: "LINK", host: "pricing.vendor.example", doi: null },
    { id: ANALYST_ITEM, kind: "DOI", host: "doi.org", doi: "10.1000/182" },
  ],
  verified: true,
} satisfies SubmittedPayloadInput;

export const GRADED_PAYLOAD = {
  stepKey: hexOf("5002"),
  ...ofTheSuggestion,
  items: [
    { id: VENDOR_ITEM, kind: "LINK", fetchStatus: "opened:200", tier: "C", base: 70, relevance: 1, recency: 1, independence: 0.8, adjusted: 56, gradedBy: "hb-small", reasonSha256: hexOf("d001"), contentSha256: hexOf("d002") },
    { id: ANALYST_ITEM, kind: "DOI", fetchStatus: "opened:200", tier: "D", base: 60, relevance: 1, recency: 0.7, independence: 1, adjusted: 42, gradedBy: "hb-small", reasonSha256: hexOf("d003"), contentSha256: hexOf("d004") },
  ],
  score: 66,
  strongestItemId: VENDOR_ITEM,
  corroboratedById: ANALYST_ITEM,
  usage: { inputTokens: 5120, outputTokens: 96, cacheReadTokens: 3800 },
  traceId: TRACE,
} satisfies GradedPayloadInput;

export const SENSORS_PAYLOAD = {
  stepKey: hexOf("5003"),
  ...ofTheSuggestion,
  verdicts: [
    { sensor: "SCHEMA", result: "PASS" },
    { sensor: "ANCHOR_EXISTS", result: "PASS" },
    { sensor: "EVIDENCE_PARSES", result: "PASS" },
    { sensor: "RATIONALE_LENGTH", result: "PASS" },
    { sensor: "DERIVE_CONSISTENCY", result: "NA" },
    { sensor: "CROSS_CHAPTER", result: "WARN" },
    { sensor: "LINT", result: "PASS" },
  ],
  parts: ["P1", "P3"],
  detailSha256: hexOf("e001"),
} satisfies SensorsPayloadInput;

export const DECIDED_PAYLOAD = {
  stepKey: hexOf("5004"),
  ...ofTheSuggestion,
  decision: "REQUEST_MORE",
  decidedBy: "adjudicator",
  score: 66,
  acceptAt: 70,
  floorAt: 25,
  sufficientTier: "D",
  failingSensor: null,
  criteria: [
    { name: "tier", verdict: "C", reasonSha256: hexOf("f001") },
    { name: "relevance", verdict: "1.0", reasonSha256: hexOf("f002") },
    { name: "recency", verdict: "1.0", reasonSha256: hexOf("f003") },
    { name: "independence", verdict: "0.8", reasonSha256: hexOf("f004") },
    { name: "corroboration", verdict: "+10", reasonSha256: hexOf("f005") },
    { name: "threshold", verdict: "66<70", reasonSha256: hexOf("f006") },
  ],
  guide: { version: "v2.1", sha256: hexOf("a2d1") },
  modelId: "hb-frontier",
  promptSha256: hexOf("b2c4"),
  usage: { inputTokens: 6400, outputTokens: 210, cacheReadTokens: 5900 },
  traceId: TRACE,
} satisfies DecidedPayloadInput;

export const CURATOR_PAYLOAD = {
  stepKey: hexOf("5005"),
  ...ofTheSuggestion,
  action: "ACCEPT",
  overrideCode: "OV-IND-02",
  criterion: "independence",
  noteSha256: hexOf("ab01"),
  seeded: false,
  seedMatched: null,
  queueWaitMs: 5_400_000,
  part: "P1",
} satisfies CuratorPayloadInput;

export const MERGED_PAYLOAD = {
  stepKey: hexOf("5006"),
  ...ofTheSuggestion,
  branch: "improve/S-15-0377-price-15-9",
  commitSha: "4d".repeat(20),
  versionFrom: "v1.3.2",
  versionTo: "v1.3.3",
  bump: "patch",
  releaseFrom: "2026.09",
  releaseTo: "2026.10",
  renderHash: hexOf("7e4d"),
  check: { lab: "NONE", lint: "PASS" },
  contributor: CONTRIBUTOR,
  endorsedBy: null,
  mergedBy: CURATOR,
  reverts: null,
} satisfies MergedPayloadInput;

export const RESEARCH_PAYLOAD = {
  stepKey: hexOf("5007"),
  runId: "00000000-0000-4000-8000-0000000057a1",
  releaseId: "2026.09",
  sections: ["21.3", "21.2"],
  gap: false,
  planned: "brief",
  briefSha256: hexOf("b41e"),
  searches: 4,
  pageReads: 6,
  findings: [
    { ordinal: 1, outcome: "PROPOSED" },
    { ordinal: 2, outcome: "DUPLICATE" },
  ],
  guide: { version: "v1.0", sha256: hexOf("a3d0") },
  models: { planner: "hb-small", reader: "hb-frontier" },
  usage: { inputTokens: 18200, outputTokens: 1340, cacheReadTokens: 9100 },
  traceId: TRACE,
} satisfies ResearchPayloadInput;

export const ENDORSED_PAYLOAD = {
  stepKey: hexOf("5008"),
  consentAt: "2026-10-05T12:00:00.000Z",
  withdrawn: false,
} satisfies EndorsedPayloadInput;

/** A contributor's withdrawal from a curator's queue (feature-specs/45 § 5.3; unit 63c). */
export const RETRACTED_PAYLOAD = {
  stepKey: hexOf("63c0"),
  rubricVersion: "v1.2",
  origin: "HUMAN",
  from: "CURATOR_QUEUE",
  outcome: "CURATOR_REVIEW",
} satisfies RetractedPayloadInput;

/** A reader's deletion of a conversation (feature-specs/45 § 3.7; unit 62d): its step key is the conversation's, as `erasedStepKeyOf` makes it. */
export const ERASED_PAYLOAD = {
  stepKey: hexOf("62d0"),
  scope: { kind: "conversation", id: "00000000-0000-4000-8000-00000000062d" },
} satisfies ErasedPayloadInput;

const aboutTheSuggestion = { suggestionId: SUGGESTION_ID, chapterVersionId: CHAPTER_VERSION_ID } as const;

/** One valid record of each of the nine kinds, as `append` takes it: the kind, who signs it, what it is about, and its payload. */
export const IMPROVE_RECORDS = [
  { kind: "SUBMITTED", actor: CONTRIBUTOR, ...aboutTheSuggestion, payload: SUBMITTED_PAYLOAD },
  { kind: "GRADED", actor: "service:grader", ...aboutTheSuggestion, payload: GRADED_PAYLOAD },
  { kind: "SENSORS", actor: "service:intake", ...aboutTheSuggestion, payload: SENSORS_PAYLOAD },
  { kind: "DECIDED", actor: "service:adjudicator", ...aboutTheSuggestion, payload: DECIDED_PAYLOAD },
  { kind: "CURATOR", actor: CURATOR, ...aboutTheSuggestion, payload: CURATOR_PAYLOAD },
  { kind: "MERGED", actor: "service:merge", ...aboutTheSuggestion, payload: MERGED_PAYLOAD },
  { kind: "RESEARCH", actor: "service:researcher", suggestionId: null, chapterVersionId: null, payload: RESEARCH_PAYLOAD },
  { kind: "ENDORSED", actor: READER, ...aboutTheSuggestion, payload: ENDORSED_PAYLOAD },
  { kind: "RETRACTED", actor: CONTRIBUTOR, ...aboutTheSuggestion, payload: RETRACTED_PAYLOAD },
] as const satisfies ReadonlyArray<AppendInput>;
