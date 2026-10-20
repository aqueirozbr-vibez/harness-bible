import { describe, expect, it } from "vitest";

import { LedgerKind as PrismaLedgerKind } from "@/lib/db/generated/enums";
import {
  ANSWER_PAYLOAD,
  CHAPTER_VERSION_ID,
  CONTRIBUTOR,
  CURATOR_PAYLOAD,
  DECIDED_PAYLOAD,
  ENDORSED_PAYLOAD,
  ERASED_PAYLOAD,
  EXPORT_PAYLOAD,
  GRADED_PAYLOAD,
  hexOf,
  IMPROVE_RECORDS,
  MERGED_PAYLOAD,
  READER,
  RESEARCH_PAYLOAD,
  RETRACTED_PAYLOAD,
  SENSORS_PAYLOAD,
  SUBMITTED_PAYLOAD,
  SUGGESTION_ID,
} from "@/tests/fixtures/ledger";

import { freeTextIn } from "./freeText";
import {
  AnswerPayloadSchema,
  CuratorPayloadSchema,
  DecidedPayloadSchema,
  EndorsedPayloadSchema,
  ErasedPayloadSchema,
  GradedPayloadSchema,
  MergedPayloadSchema,
  PseudonymSchema,
  recordIssue,
  ResearchPayloadSchema,
  RetractedPayloadSchema,
  SensorsPayloadSchema,
  SubmittedPayloadSchema,
  ExportLineSchema,
  ExportPayloadSchema,
  ExportScopeSchema,
  ExportTrailerLineSchema,
  ExportTrailerSchema,
  IsoInstantSchema,
  LEDGER_KINDS,
  LedgerKindSchema,
  LedgerPayloadSchema,
  SENSOR_VERDICTS,
  firstUnstorable,
  unstorableText,
  SensorVerdictValueSchema,
  Sha256Schema,
} from "./ledger";

/*
 * The record kinds and the two Phase 2 payloads (feature-specs/14 § 6, § 9.2):
 * a free-text field where a hash is expected fails the schema, an extra
 * field cannot ride along, and the Phase 4 kinds are named but empty. The
 * export file's two line shapes (§ 5.2) are checked field by field here;
 * lib/ledger/export.test.ts checks that verifyExport names the line.
 */

const SENTENCE = "The cached-input price is US$ 0.25 per M tokens, verified 12 Sep 2026.";

/** A chapter export's record line for seq 6: the hashed form plus `hash`, carrying its predecessor. */
const LINE = {
  seq: 6,
  kind: "ANSWER",
  actor: "00000000-0000-4000-8000-00000000028d",
  suggestionId: null,
  chapterVersionId: "cv-21",
  payload: { messageId: "m-6", claims: { total: 6, substituted: 0 }, citations: [["21.3", null]] },
  createdAt: "2026-09-23T14:35:00.006Z",
  prevHash: hexOf("05"),
  hash: hexOf("06"),
  predecessor: { seq: 5, hash: hexOf("05") },
};

const TRAILER = {
  headHash: hexOf("1e"),
  fromSeq: 3,
  toSeq: 30,
  records: 10,
  scope: { kind: "chapter", id: "cv-21", from: null, to: null },
  exportedAt: "2026-09-23T16:00:00.000Z",
  signature: "ab".repeat(64),
};

describe("LedgerKindSchema", () => {
  it("mirrors the Prisma enum exactly, in order", () => {
    expect(Object.values(PrismaLedgerKind)).toEqual([...LEDGER_KINDS]);
    expect(LedgerKindSchema.options).toEqual([...LEDGER_KINDS]);
    expect(LedgerKindSchema.safeParse("answer").success).toBe(false);
  });
});

describe("Sha256Schema", () => {
  it("accepts 64 lower-case hex characters and nothing else", () => {
    expect(Sha256Schema.safeParse(hexOf("8c21f04e9ab3")).success).toBe(true);
    for (const wrong of [SENTENCE, hexOf("8c21").toUpperCase(), hexOf("8c21").slice(0, 63), `${hexOf("8c21")}0`, "", hexOf("8c21").replace("0", "g")]) {
      expect(Sha256Schema.safeParse(wrong).success).toBe(false);
    }
  });
});

describe("IsoInstantSchema", () => {
  it("accepts the form Date.prototype.toISOString writes and nothing else", () => {
    expect(IsoInstantSchema.safeParse("2026-09-23T14:35:00.006Z").success).toBe(true);
    expect(IsoInstantSchema.safeParse(new Date(Date.UTC(2026, 8, 23, 14, 35, 0, 6)).toISOString()).success).toBe(true);
    for (const wrong of ["2026-09-23T14:35:00Z", "2026-09-23T14:35:00.0060Z", "2026-09-23T14:35:00.006+02:00", "2026-09-23", "12 Sep 2026", "2026-02-30T00:00:00.000Z", 1]) {
      expect(IsoInstantSchema.safeParse(wrong).success, String(wrong)).toBe(false);
    }
  });
});

describe("SensorVerdictValueSchema", () => {
  it("is the four verdicts of code-standards § Workers and nothing else", () => {
    expect([...SENSOR_VERDICTS]).toEqual(["PASS", "FAIL", "WARN", "NA"]);
    expect(SensorVerdictValueSchema.options).toEqual([...SENSOR_VERDICTS]);
    expect(SensorVerdictValueSchema.safeParse("OK").success).toBe(false);
    expect(SensorVerdictValueSchema.safeParse("pass").success).toBe(false);
  });
});

describe("AnswerPayloadSchema", () => {
  it("accepts the fixture and returns it unchanged", () => {
    const parsed = AnswerPayloadSchema.parse(ANSWER_PAYLOAD);
    expect(parsed).toEqual(ANSWER_PAYLOAD);
  });

  it("accepts a refusal, a null grounded score and a missing first token", () => {
    const refused = { ...ANSWER_PAYLOAD, refusal: { cause: "R-SCOPE-OT", beforeRetrieval: true }, citations: [], claims: { total: 0, substituted: 0 }, grounded: null, timings: { firstTokenMs: null, totalMs: 12 } };
    expect(AnswerPayloadSchema.safeParse(refused).success).toBe(true);
  });

  it("refuses text where a hash is expected, in every hash field", () => {
    for (const field of ["promptSha256", "questionSha256", "answerSha256"] as const) {
      const result = AnswerPayloadSchema.safeParse({ ...ANSWER_PAYLOAD, [field]: SENTENCE });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual([field]);
    }
    const guide = AnswerPayloadSchema.safeParse({ ...ANSWER_PAYLOAD, guide: { version: "v1.8", sha256: SENTENCE } });
    expect(guide.success).toBe(false);
    expect(guide.error?.issues[0]?.path).toEqual(["guide", "sha256"]);
  });

  it("refuses a field the schema does not name, so free text cannot ride along", () => {
    const result = AnswerPayloadSchema.safeParse({ ...ANSWER_PAYLOAD, question: SENTENCE });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
    const nested = AnswerPayloadSchema.safeParse({ ...ANSWER_PAYLOAD, citations: [{ ...ANSWER_PAYLOAD.citations[0], claimText: SENTENCE }] });
    expect(nested.success).toBe(false);
  });

  it("refuses ids, enums and ranges outside their form", () => {
    const wrong: ReadonlyArray<[string, Partial<Record<keyof typeof ANSWER_PAYLOAD, unknown>>]> = [
      ["messageId", { messageId: "m-1" }],
      ["conversationId", { conversationId: "c-1" }],
      ["releaseId", { releaseId: "2026.9" }],
      ["mode", { mode: "chat" }],
      ["refusal", { refusal: { cause: "R-OTHER", beforeRetrieval: true } }],
      ["citations", { citations: [{ sectionId: "21.10", figureId: null, version: "v1.5.0", editionLang: "EN" }] }],
      ["citations", { citations: [{ sectionId: "21.3", figureId: "21-03", version: "v1.5.0", editionLang: "EN" }] }],
      ["citations", { citations: [{ sectionId: "21.3", figureId: null, version: "v1.5.0", editionLang: "en" }] }],
      ["claims", { claims: { total: 4.5, substituted: 0 } }],
      ["verdicts", { verdicts: [{ sensor: "citation", verdict: "OK" }] }],
      ["grounded", { grounded: 1.2 }],
      ["grounded", { grounded: -0.1 }],
      ["repaired", { repaired: "no" }],
      ["usage", { usage: { inputTokens: 1.5, outputTokens: 0, cacheReadTokens: 0 } }],
      ["timings", { timings: { firstTokenMs: 1300 } }],
    ];
    for (const [field, patch] of wrong) {
      const result = AnswerPayloadSchema.safeParse({ ...ANSWER_PAYLOAD, ...patch });
      expect(result.success, field).toBe(false);
      expect(result.error?.issues[0]?.path[0], field).toBe(field);
    }
  });
});

describe("ExportScopeSchema", () => {
  it("accepts each scope kind with the id rule and ISO-8601 UTC dates", () => {
    expect(ExportScopeSchema.safeParse({ kind: "all", id: null, from: null, to: null }).success).toBe(true);
    expect(ExportScopeSchema.safeParse({ kind: "all", id: null, from: "2026-09-01T00:00:00.000Z", to: "2026-09-23T14:35:00.123Z" }).success).toBe(true);
    for (const kind of ["suggestion", "chapter", "account", "messages", "research"]) {
      expect(ExportScopeSchema.safeParse({ kind, id: "cv-21", from: null, to: null }).success).toBe(true);
    }
  });

  it("refuses an id on the all scope, a missing id elsewhere, an unknown kind and a date that is not ISO-8601 UTC", () => {
    const withId = ExportScopeSchema.safeParse({ kind: "all", id: "cv-21", from: null, to: null });
    expect(withId.success).toBe(false);
    expect(withId.error?.issues[0]?.path).toEqual(["id"]);
    const without = ExportScopeSchema.safeParse({ kind: "chapter", id: null, from: null, to: null });
    expect(without.success).toBe(false);
    expect(without.error?.issues[0]?.path).toEqual(["id"]);
    expect(ExportScopeSchema.safeParse({ kind: "chapter", id: "", from: null, to: null }).success).toBe(false);
    /* `messages` became a kind with unit 31 (a conversation's own records); `release` is nobody's scope. */
    expect(ExportScopeSchema.safeParse({ kind: "release", id: "2026.09", from: null, to: null }).success).toBe(false);
    expect(ExportScopeSchema.safeParse({ kind: "all", id: null, from: "12 Sep 2026", to: null }).success).toBe(false);
    expect(ExportScopeSchema.safeParse({ kind: "all", id: null, from: null, to: "2026-09-23T14:35:00+02:00" }).success).toBe(false);
    expect(ExportScopeSchema.safeParse({ kind: "all", id: null, from: "2026-09-23T14:35:00Z", to: null }).success).toBe(false);
    expect(ExportScopeSchema.safeParse({ kind: "all", id: null, from: null }).success).toBe(false);
  });
});

describe("ExportLineSchema", () => {
  it("accepts a record line with its predecessor, with a null one on the genesis record, and without one on a contiguous export", () => {
    expect(ExportLineSchema.parse(LINE)).toEqual(LINE);
    const genesis = { ...LINE, seq: 1, prevHash: hexOf("9e"), predecessor: null };
    expect(ExportLineSchema.parse(genesis)).toEqual(genesis);
    const bare: Record<string, unknown> = { ...LINE };
    delete bare.predecessor;
    const parsed = ExportLineSchema.parse(bare);
    expect(parsed).toEqual(bare);
    expect("predecessor" in parsed).toBe(false);
  });

  it("refuses a line of the wrong shape, naming the field", () => {
    const wrong: ReadonlyArray<[string, Record<string, unknown>]> = [
      ["extra", { extra: 1 }],
      ["seq", { seq: "6" }],
      ["seq", { seq: 0 }],
      ["seq", { seq: 6.5 }],
      ["kind", { kind: null }],
      ["kind", { kind: "answer" }],
      ["actor", { actor: 1 }],
      ["suggestionId", { suggestionId: 1 }],
      ["chapterVersionId", { chapterVersionId: 1 }],
      ["payload", { payload: undefined }],
      ["createdAt", { createdAt: 1 }],
      ["createdAt", { createdAt: "2026-09-23T14:35:00Z" }],
      ["prevHash", { prevHash: null }],
      ["prevHash", { prevHash: "9e" }],
      ["hash", { hash: 1 }],
      ["hash", { hash: hexOf("ab").toUpperCase() }],
      ["predecessor", { predecessor: "5" }],
      ["predecessor", { predecessor: { seq: 5 } }],
      ["predecessor", { predecessor: { seq: "5", hash: hexOf("05") } }],
      ["predecessor", { predecessor: { seq: 5, hash: 5 } }],
      ["predecessor", { predecessor: { seq: 5, hash: hexOf("05"), extra: 1 } }],
    ];
    for (const [field, patch] of wrong) {
      const result = ExportLineSchema.safeParse({ ...LINE, ...patch });
      expect(result.success, field).toBe(false);
      expect(result.error?.issues[0]?.path[0] ?? result.error?.issues[0]?.code, field).toBe(field === "extra" ? "unrecognized_keys" : field);
    }
  });
});

describe("ExportTrailerSchema", () => {
  it("accepts the trailer and its line, with the scope the EXPORT payload is written with", () => {
    expect(ExportTrailerSchema.parse(TRAILER)).toEqual(TRAILER);
    expect(ExportTrailerLineSchema.parse({ trailer: TRAILER })).toEqual({ trailer: TRAILER });
    const windowed = { ...TRAILER, scope: { kind: "all", id: null, from: "2026-09-23T00:00:00.000Z", to: "2026-09-24T00:00:00.000Z" } };
    expect(ExportTrailerSchema.safeParse(windowed).success).toBe(true);
    expect(ExportPayloadSchema.safeParse({ ...EXPORT_PAYLOAD, scope: windowed.scope }).success).toBe(true);
  });

  it("refuses a trailer of the wrong shape, naming the field, and a scope the EXPORT payload refuses", () => {
    const wrong: ReadonlyArray<[string, Record<string, unknown>]> = [
      ["extra", { extra: 1 }],
      ["scope", { scope: null }],
      ["scope", { scope: { ...TRAILER.scope, extra: 1 } }],
      ["scope", { scope: { ...TRAILER.scope, kind: "everything" } }],
      ["scope", { scope: { ...TRAILER.scope, kind: 1 } }],
      ["scope", { scope: { ...TRAILER.scope, id: 1 } }],
      ["scope", { scope: { ...TRAILER.scope, from: 1 } }],
      ["scope", { scope: { ...TRAILER.scope, to: 1 } }],
      ["scope", { scope: { kind: "all", id: "x", from: "yesterday", to: null } }],
      ["headHash", { headHash: 1 }],
      ["headHash", { headHash: "9b41d2e07a3c" }],
      ["fromSeq", { fromSeq: 0 }],
      ["toSeq", { toSeq: 1.5 }],
      ["records", { records: "30" }],
      ["exportedAt", { exportedAt: "2026-09-23" }],
      ["exportedAt", { exportedAt: "not a date" }],
      ["signature", { signature: null }],
      ["signature", { signature: "zz" }],
      ["signature", { signature: "" }],
      ["signature", { signature: "AB".repeat(64) }],
      ["signature", { signature: "ab".repeat(63) }],
    ];
    for (const [field, patch] of wrong) {
      const result = ExportTrailerSchema.safeParse({ ...TRAILER, ...patch });
      expect(result.success, field).toBe(false);
      expect(result.error?.issues[0]?.path[0] ?? result.error?.issues[0]?.code, field).toBe(field === "extra" ? "unrecognized_keys" : field);
    }
    expect(ExportTrailerLineSchema.safeParse({ trailer: TRAILER, extra: 1 }).success).toBe(false);
    expect(ExportTrailerLineSchema.safeParse({ trailer: "x" }).success).toBe(false);
  });
});

describe("ExportPayloadSchema", () => {
  it("accepts what the export script appends", () => {
    expect(ExportPayloadSchema.parse(EXPORT_PAYLOAD)).toEqual(EXPORT_PAYLOAD);
  });

  it("refuses a non-hash head or file hash, a fractional seq and an extra field", () => {
    expect(ExportPayloadSchema.safeParse({ ...EXPORT_PAYLOAD, headHash: "9b41d2e07a3c" }).success).toBe(false);
    expect(ExportPayloadSchema.safeParse({ ...EXPORT_PAYLOAD, fileSha256: SENTENCE }).success).toBe(false);
    expect(ExportPayloadSchema.safeParse({ ...EXPORT_PAYLOAD, fromSeq: 1.5 }).success).toBe(false);
    expect(ExportPayloadSchema.safeParse({ ...EXPORT_PAYLOAD, path: "C:/exports/ledger.jsonl" }).success).toBe(false);
  });
});

describe("LedgerPayloadSchema", () => {
  it("pairs each Phase 2 kind with its own payload and no other", () => {
    expect(LedgerPayloadSchema.safeParse({ kind: "ANSWER", payload: ANSWER_PAYLOAD }).success).toBe(true);
    expect(LedgerPayloadSchema.safeParse({ kind: "EXPORT", payload: EXPORT_PAYLOAD }).success).toBe(true);
    expect(LedgerPayloadSchema.safeParse({ kind: "ANSWER", payload: EXPORT_PAYLOAD }).success).toBe(false);
    expect(LedgerPayloadSchema.safeParse({ kind: "EXPORT", payload: ANSWER_PAYLOAD }).success).toBe(false);
    expect(LedgerPayloadSchema.safeParse({ kind: "answer", payload: ANSWER_PAYLOAD }).success).toBe(false);
    expect(LedgerPayloadSchema.safeParse({ kind: "ANSWER", payload: ANSWER_PAYLOAD, actor: "x" }).success).toBe(false);
  });

  it("pairs each of the eight kinds of Improve and the researcher with its own payload and no other", () => {
    for (const record of IMPROVE_RECORDS) {
      expect(LedgerPayloadSchema.safeParse({ kind: record.kind, payload: record.payload }).success, record.kind).toBe(true);
      expect(LedgerPayloadSchema.safeParse({ kind: record.kind, payload: {} }).success, record.kind).toBe(false);
      expect(LedgerPayloadSchema.safeParse({ kind: record.kind, payload: "text" }).success, record.kind).toBe(false);
      for (const other of IMPROVE_RECORDS) {
        if (other.kind !== record.kind) expect(LedgerPayloadSchema.safeParse({ kind: record.kind, payload: other.payload }).success, `${record.kind} with the payload of ${other.kind}`).toBe(false);
      }
    }
  });
});

/*
 * feature-specs/29 § 5, § 10.5; architecture § 11, invariant 18. The nine payloads (a withdrawal's since unit 63c) are strict, and no member of
 * any of them can hold a sentence. Both are checked the general way, by walking the fixture and the schema, so a
 * member added to a payload later is held to them without a line being added here.
 */
describe("the ten payloads of Improve, the researcher and a reader's deletion", () => {
  const PAYLOADS = [
    ["SUBMITTED", SubmittedPayloadSchema, SUBMITTED_PAYLOAD],
    ["GRADED", GradedPayloadSchema, GRADED_PAYLOAD],
    ["SENSORS", SensorsPayloadSchema, SENSORS_PAYLOAD],
    ["DECIDED", DecidedPayloadSchema, DECIDED_PAYLOAD],
    ["CURATOR", CuratorPayloadSchema, CURATOR_PAYLOAD],
    ["MERGED", MergedPayloadSchema, MERGED_PAYLOAD],
    ["RESEARCH", ResearchPayloadSchema, RESEARCH_PAYLOAD],
    ["ENDORSED", EndorsedPayloadSchema, ENDORSED_PAYLOAD],
    ["RETRACTED", RetractedPayloadSchema, RETRACTED_PAYLOAD],
    ["ERASED", ErasedPayloadSchema, ERASED_PAYLOAD],
  ] as const;

  type Json = string | number | boolean | null | ReadonlyArray<Json> | { readonly [key: string]: Json };
  const isObject = (value: Json): value is { readonly [key: string]: Json } => typeof value === "object" && value !== null && !Array.isArray(value);

  /** Every copy of `value` that differs from it in one place: `change` applied at one node, the rest as it was. */
  function variants(value: Json, change: (node: Json) => Json | undefined, path = "$"): ReadonlyArray<readonly [string, Json]> {
    const here = change(value);
    const own: ReadonlyArray<readonly [string, Json]> = here === undefined ? [] : [[path, here]];
    if (Array.isArray(value)) {
      return [...own, ...value.flatMap((item: Json, index: number) => variants(item, change, `${path}[${String(index)}]`).map(([at, changed]) => [at, value.map((each: Json, i: number) => (i === index ? changed : each))] as const))];
    }
    if (isObject(value)) {
      return [...own, ...Object.entries(value).flatMap(([key, member]) => variants(member, change, `${path}.${key}`).map(([at, changed]) => [at, { ...value, [key]: changed }] as const))];
    }
    return own;
  }

  it("accept their fixtures and return them unchanged", () => {
    for (const [kind, schema, fixture] of PAYLOADS) expect(schema.parse(fixture), kind).toEqual(fixture);
  });

  it("refuse a key nobody named, at the top and in every object inside", () => {
    for (const [kind, schema, fixture] of PAYLOADS) {
      const withAKey = variants(fixture, (node) => (isObject(node) ? { ...node, note: "the curator's own words" } : undefined));
      expect(withAKey.length, kind).toBeGreaterThan(0);
      for (const [at, payload] of withAKey) expect(schema.safeParse(payload).success, `${kind} ${at}`).toBe(false);
    }
  });

  it("refuse a sentence in place of any string they hold", () => {
    let strings = 0;
    for (const [kind, schema, fixture] of PAYLOADS) {
      for (const [at, payload] of variants(fixture, (node) => (typeof node === "string" ? SENTENCE : undefined))) {
        strings += 1;
        expect(schema.safeParse(payload).success, `${kind} ${at}`).toBe(false);
      }
    }
    expect(strings).toBeGreaterThan(90);
  });

  it("have no place a sentence could be put, by the walk that holds the workflows' schemas to the same", () => {
    for (const [kind, schema] of PAYLOADS) expect(freeTextIn(schema), kind).toEqual([]);
  });

  it("carry the step key, the rubric's version and the origin on the six records of a suggestion", () => {
    for (const [kind, schema, fixture] of PAYLOADS.slice(0, 6)) {
      for (const member of ["stepKey", "rubricVersion", "origin"]) {
        const without = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== member));
        expect(schema.safeParse(without).success, `${kind} without ${member}`).toBe(false);
      }
      expect(schema.safeParse({ ...fixture, rubricVersion: "1.2" }).success, kind).toBe(false);
      expect(schema.safeParse({ ...fixture, origin: "EDITOR" }).success, kind).toBe(false);
    }
  });

  it("submitted: the reason goes with its class, the anchor with its kind, and verified with a person", () => {
    const ok = (payload: unknown): boolean => SubmittedPayloadSchema.safeParse(payload).success;
    expect(ok({ ...SUBMITTED_PAYLOAD, changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT" })).toBe(true);
    expect(ok({ ...SUBMITTED_PAYLOAD, changeClass: "CURATOR_ALWAYS" })).toBe(false);
    expect(ok({ ...SUBMITTED_PAYLOAD, curatorReason: "SAFETY_OT" })).toBe(false);
    const anchor = SUBMITTED_PAYLOAD.anchor;
    expect(ok({ ...SUBMITTED_PAYLOAD, anchor: { ...anchor, kind: "SECTION", sourceRow: null } })).toBe(true);
    expect(ok({ ...SUBMITTED_PAYLOAD, anchor: { ...anchor, kind: "FIGURE", figure: "F-15-04", sourceRow: null } })).toBe(true);
    expect(ok({ ...SUBMITTED_PAYLOAD, anchor: { ...anchor, kind: "SECTION" } })).toBe(false);
    expect(ok({ ...SUBMITTED_PAYLOAD, anchor: { ...anchor, kind: "FIGURE" } })).toBe(false);
    expect(ok({ ...SUBMITTED_PAYLOAD, anchor: { ...anchor, sourceRow: null } })).toBe(false);
    expect(ok({ ...SUBMITTED_PAYLOAD, anchor: { ...anchor, figure: "F-15-04" } })).toBe(false);
    expect(ok({ ...SUBMITTED_PAYLOAD, origin: "RESEARCHER", verified: null, rationaleSha256: null, rationaleWords: 0 })).toBe(true);
    expect(ok({ ...SUBMITTED_PAYLOAD, origin: "RESEARCHER" })).toBe(false);
    expect(ok({ ...SUBMITTED_PAYLOAD, verified: null })).toBe(false);
    expect(ok({ ...SUBMITTED_PAYLOAD, evidence: [{ ...SUBMITTED_PAYLOAD.evidence[0], host: "Pricing.Vendor.Example" }] })).toBe(false);
    expect(ok({ ...SUBMITTED_PAYLOAD, evidence: [{ ...SUBMITTED_PAYLOAD.evidence[1], doi: "doi:10.1000/182" }] })).toBe(false);
  });

  it("graded: a factor is never above one, a base never above a hundred, and an item nobody could open has neither factors nor text", () => {
    const [vendor] = GRADED_PAYLOAD.items;
    const ok = (item: unknown): boolean => GradedPayloadSchema.safeParse({ ...GRADED_PAYLOAD, items: [item] }).success;
    expect(ok({ ...vendor, fetchStatus: "unreachable:403", tier: "U", base: 0, relevance: null, recency: null, independence: null, adjusted: 0, gradedBy: "intake-rules", contentSha256: null })).toBe(true);
    for (const status of ["unreachable:timeout", "unsupported:application/zip", "not_supplied", "opened:200"]) expect(ok({ ...vendor, fetchStatus: status }), status).toBe(true);
    for (const status of ["opened", "unreachable:the server said no", "blocked", ""]) expect(ok({ ...vendor, fetchStatus: status }), status).toBe(false);
    expect(ok({ ...vendor, independence: 1.2 })).toBe(false);
    expect(ok({ ...vendor, base: 101 })).toBe(false);
    expect(ok({ ...vendor, adjusted: 56.5 })).toBe(false);
    expect(ok({ ...vendor, tier: "H" })).toBe(false);
    expect(GradedPayloadSchema.safeParse({ ...GRADED_PAYLOAD, strongestItemId: null, corroboratedById: null, items: [], score: 0 }).success).toBe(true);
  });

  it("decided: one line for a criterion, and the guide, the model and the prompt together or not at all", () => {
    const ok = (payload: unknown): boolean => DecidedPayloadSchema.safeParse(payload).success;
    const byRule = { ...DECIDED_PAYLOAD, decision: "DECLINE", decidedBy: "intake-rules", guide: null, modelId: null, promptSha256: null, sufficientTier: null, failingSensor: "ANCHOR_EXISTS", criteria: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
    expect(ok(byRule)).toBe(true);
    expect(ok({ ...byRule, decidedBy: "router" })).toBe(true);
    expect(ok({ ...byRule, modelId: "hb-frontier" })).toBe(false);
    expect(ok({ ...DECIDED_PAYLOAD, guide: null })).toBe(false);
    expect(ok({ ...DECIDED_PAYLOAD, promptSha256: null })).toBe(false);
    /* the adjudicator's failure has what it had when it failed (unit 50e); a rule's decision still has none */
    const failed = { ...DECIDED_PAYLOAD, decision: "CURATOR_REVIEW", sufficientTier: null, criteria: [] };
    expect(ok({ ...failed, modelId: null, promptSha256: null })).toBe(true);
    expect(ok({ ...failed, guide: null, modelId: null, promptSha256: null })).toBe(true);
    expect(ok({ ...byRule, decision: "CURATOR_REVIEW", decidedBy: "router", guide: { version: "v2.1", sha256: "a".repeat(64) } })).toBe(false);
    expect(ok({ ...DECIDED_PAYLOAD, criteria: [...DECIDED_PAYLOAD.criteria, DECIDED_PAYLOAD.criteria[0]] })).toBe(false);
    expect(ok({ ...DECIDED_PAYLOAD, criteria: [{ ...DECIDED_PAYLOAD.criteria[0], verdict: "below the floor" }] })).toBe(false);
    expect(ok({ ...DECIDED_PAYLOAD, criteria: [{ ...DECIDED_PAYLOAD.criteria[0], name: "novelty" }] })).toBe(false);
    expect(ok({ ...DECIDED_PAYLOAD, decidedBy: "curator" })).toBe(false);
  });

  it("curator and merged: a code, a branch, a commit and a version each have their form, and a person is a pseudonym", () => {
    expect(CuratorPayloadSchema.safeParse({ ...CURATOR_PAYLOAD, overrideCode: null, criterion: null, noteSha256: null, action: "DECLINE" }).success).toBe(true);
    for (const code of ["OV-IND-2", "ov-ind-02", "independence waived", "OV-INDEP-02"]) expect(CuratorPayloadSchema.safeParse({ ...CURATOR_PAYLOAD, overrideCode: code }).success, code).toBe(false);
    expect(CuratorPayloadSchema.safeParse({ ...CURATOR_PAYLOAD, queueWaitMs: -1 }).success).toBe(false);
    const merged = (over: object): boolean => MergedPayloadSchema.safeParse({ ...MERGED_PAYLOAD, ...over }).success;
    expect(merged({ contributor: null, endorsedBy: "user:00000000-0000-4000-8000-0000000046c3", origin: "RESEARCHER" })).toBe(true);
    expect(merged({ reverts: "S-15-0301", commitSha: "4d".repeat(32) })).toBe(true);
    for (const over of [{ branch: "main" }, { branch: "improve/S-15-0377" }, { branch: "improve/S-15-0377-Price 15.9" }, { commitSha: "4d4d4d4" }, { versionTo: "1.3.3" }, { bump: "tiny" }, { releaseTo: "2026-10" }, { check: { lab: "skipped", lint: "PASS" } }, { mergedBy: null }, { mergedBy: "Ana Curator" }, { contributor: "00000000-0000-4000-8000-0000000046c1" }, { reverts: "the last one" }]) {
      expect(merged(over), JSON.stringify(over)).toBe(false);
    }
    expect(PseudonymSchema.safeParse(CONTRIBUTOR).success).toBe(true);
    expect(PseudonymSchema.safeParse("user:ana@example.org").success).toBe(false);
  });

  it("research and endorsed: a brief and a reader go with a run that planned one; an endorsement says when, and whether it was taken back", () => {
    const research = (over: object): boolean => ResearchPayloadSchema.safeParse({ ...RESEARCH_PAYLOAD, ...over }).success;
    expect(research({ planned: "nothing", briefSha256: null, models: { planner: "hb-small", reader: null }, findings: [], searches: 0, pageReads: 0 })).toBe(true);
    expect(research({ planned: "nothing" })).toBe(false);
    expect(research({ briefSha256: null })).toBe(false);
    expect(research({ models: { planner: "hb-small", reader: null } })).toBe(false);
    expect(research({ findings: [{ ordinal: 0, outcome: "PROPOSED" }] })).toBe(false);
    expect(research({ findings: [{ ordinal: 1, outcome: "ACCEPTED" }] })).toBe(false);
    expect(research({ sections: ["21.3", "the pricing section"] })).toBe(false);
    for (const member of ["suggestionId", "messageId", "userId", "question"]) expect(research({ [member]: SUGGESTION_ID }), member).toBe(false);
    expect(EndorsedPayloadSchema.safeParse({ ...ENDORSED_PAYLOAD, withdrawn: true }).success).toBe(true);
    expect(EndorsedPayloadSchema.safeParse({ ...ENDORSED_PAYLOAD, consentAt: "5 October 2026" }).success).toBe(false);
    expect(EndorsedPayloadSchema.safeParse({ stepKey: ENDORSED_PAYLOAD.stepKey, consentAt: ENDORSED_PAYLOAD.consentAt }).success).toBe(false);
  });

  it("research of a person's run (48 § 15): its conversation, the question's hash, the report's, the writer; a refusal with its code in capitals", () => {
    const research = (over: object): boolean => ResearchPayloadSchema.safeParse({ ...RESEARCH_PAYLOAD, ...over }).success;
    const PERSON = {
      conversationId: "00000000-0000-4000-8000-000000004801",
      questionSha256: "a".repeat(64),
      reportSha256: "b".repeat(64),
      refusal: null,
      models: { planner: "hb-small", reader: "hb-frontier", writer: "hb-frontier" },
      findings: [
        { ordinal: 1, outcome: "VALID" },
        { ordinal: 2, outcome: "INVALID" },
      ],
    };
    expect(research(PERSON)).toBe(true);
    /* a legacy record carries none of the new members, and stays valid */
    expect(research({})).toBe(true);
    /* the planner refused: no brief, no reader, no writer, no report; the end's code is the cause with underscores */
    const REFUSED = { ...PERSON, planned: "refused", briefSha256: null, reportSha256: null, refusal: "R-SCOPE", models: { planner: "hb-small", reader: null, writer: null }, findings: [], searches: 0, pageReads: 0, end: { state: "REFUSED", code: "R_SCOPE" } };
    expect(research(REFUSED)).toBe(true);
    expect(research({ ...REFUSED, refusal: "R-PERSONAL", end: { state: "REFUSED", code: "R_PERSONAL" } })).toBe(true);
    /* a refused plan names its cause and ended refused */
    expect(research({ ...REFUSED, refusal: undefined })).toBe(false);
    expect(research({ ...REFUSED, end: { state: "DONE", code: null } })).toBe(false);
    expect(research({ ...REFUSED, end: { state: "FAILED", code: "INTERNAL" } })).toBe(false);
    expect(research({ ...REFUSED, end: undefined })).toBe(true);
    /* a run its conversation's delete detached is still owed its record (48 § 17.2) */
    expect(research({ ...PERSON, conversationId: null })).toBe(true);
    /* a code has no hyphen, and a refused end names its refusal's code */
    expect(research({ ...REFUSED, end: { state: "REFUSED", code: "R-SCOPE" } })).toBe(false);
    expect(research({ ...REFUSED, end: { state: "REFUSED", code: "R_PERSONAL" } })).toBe(false);
    expect(research({ ...REFUSED, end: { state: "REFUSED", code: null } })).toBe(false);
    /* a refusal goes with a refused plan and no other; the start's own causes never reach a record */
    expect(research({ ...REFUSED, refusal: null })).toBe(false);
    expect(research({ ...PERSON, refusal: "R-SCOPE" })).toBe(false);
    expect(research({ ...REFUSED, refusal: "R-SCOPE-OT", end: { state: "REFUSED", code: "R_SCOPE_OT" } })).toBe(false);
    expect(research({ ...REFUSED, refusal: "R-UNVERIFIED", end: { state: "REFUSED", code: "R_UNVERIFIED" } })).toBe(false);
    /* no sentence in any new member */
    expect(research({ ...PERSON, questionSha256: "what does the book say about refunds" })).toBe(false);
    expect(research({ ...PERSON, reportSha256: "the report said the book is out of date" })).toBe(false);
    expect(research({ ...PERSON, conversationId: "my refunds research" })).toBe(false);
    expect(research({ ...PERSON, refusal: "not about the book" })).toBe(false);
    expect(research({ ...PERSON, models: { ...PERSON.models, writer: "a model that writes" } })).toBe(false);
    for (const member of ["report", "steps", "brief", "says", "notes"]) expect(research({ ...PERSON, [member]: "x" }), member).toBe(false);
  });

  it("retracted: a person's suggestion, from where its workflow waited for a person, under the decision it was waiting with (45 § 5.3)", () => {
    const retracted = (over: object): boolean => RetractedPayloadSchema.safeParse({ ...RETRACTED_PAYLOAD, ...over }).success;
    expect(retracted({ from: "INTAKE_DECLINED", outcome: "DECLINE" })).toBe(true);
    expect(retracted({ from: "DECIDED", outcome: "REQUEST_MORE" })).toBe(true);
    expect(retracted({ from: "CURATOR_QUEUE", outcome: "REQUEST_MORE" })).toBe(true);
    expect(retracted({ from: "CURATOR_QUEUE", outcome: null })).toBe(true);
    /* accepted and on its way to the merge, or past it: not where a person is waited for */
    expect(retracted({ from: "DECIDED", outcome: "ACCEPT" })).toBe(false);
    for (const from of ["SUBMITTED", "MERGING", "MERGED", "CLOSED", "DRAFT"]) expect(retracted({ from }), from).toBe(false);
    /* a researcher's proposal and a revert have no contributor to withdraw them */
    expect(retracted({ origin: "RESEARCHER" })).toBe(false);
    expect(retracted({ origin: "CURATOR" })).toBe(false);
    for (const member of ["stepKey", "rubricVersion", "origin", "from", "outcome"]) {
      const without = Object.fromEntries(Object.entries(RETRACTED_PAYLOAD).filter(([key]) => key !== member));
      expect(RetractedPayloadSchema.safeParse(without).success, `without ${member}`).toBe(false);
    }
  });

  it("erased: a conversation by its id and the step key, and nothing more — no text, no other scope (45 § 3.7)", () => {
    const erased = (over: object): boolean => ErasedPayloadSchema.safeParse({ ...ERASED_PAYLOAD, ...over }).success;
    expect(erased({})).toBe(true);
    expect(LedgerPayloadSchema.safeParse({ kind: "ERASED", payload: ERASED_PAYLOAD }).success).toBe(true);
    /* a person's research conversation, since unit 68 (48 § 15) */
    expect(erased({ scope: { kind: "research", id: ERASED_PAYLOAD.scope.id } })).toBe(true);
    expect(erased({ scope: { kind: "research", id: "my refunds research" } })).toBe(false);
    expect(erased({ scope: { kind: "account", id: ERASED_PAYLOAD.scope.id } })).toBe(false);
    expect(erased({ scope: { kind: "conversation", id: "the refunds conversation" } })).toBe(false);
    expect(erased({ scope: { ...ERASED_PAYLOAD.scope, title: "Refunds" } })).toBe(false);
    for (const member of ["question", "messages", "userId"]) expect(erased({ [member]: "x" }), member).toBe(false);
    expect(erased({ stepKey: "conversation:erased" })).toBe(false);
  });
});

describe("recordIssue: a record's own columns for its kind (feature-specs/29 § 5)", () => {
  const about = { suggestionId: SUGGESTION_ID, chapterVersionId: CHAPTER_VERSION_ID };

  it("finds nothing wrong with a record of each of the eight kinds as the fixtures sign them", () => {
    for (const record of IMPROVE_RECORDS) expect(recordIssue(record), record.kind).toBeNull();
    expect(recordIssue({ kind: "SUBMITTED", actor: "service:researcher", ...about })).toBeNull();
    expect(recordIssue({ kind: "DECIDED", actor: "service:intake", ...about })).toBeNull();
  });

  it("refuses an actor that is not the kind's: a person where a service signs, a service where a person does, another service", () => {
    const forged: ReadonlyArray<readonly [string, string]> = [
      ["SUBMITTED", "service:grader"],
      ["GRADED", CONTRIBUTOR],
      ["GRADED", "service:adjudicator"],
      ["SENSORS", "service:grader"],
      ["DECIDED", CONTRIBUTOR],
      ["DECIDED", "service:merge"],
      ["CURATOR", "service:adjudicator"],
      ["CURATOR", "user:ana@example.org"],
      ["CURATOR", "00000000-0000-4000-8000-0000000046c2"],
      ["MERGED", CONTRIBUTOR],
      ["ENDORSED", "service:researcher"],
      ["RETRACTED", "service:intake"],
      ["RETRACTED", "00000000-0000-4000-8000-0000000046c1"],
    ];
    for (const [kind, actor] of forged) {
      const issue = recordIssue({ kind: kind as (typeof IMPROVE_RECORDS)[number]["kind"], actor, ...about });
      expect(issue, `${kind} by ${actor}`).toContain(`the actor of a ${kind} record is`);
      expect(issue, `${kind} by ${actor}`).not.toContain(actor);
    }
    /* a legacy run's record is the researcher's; a person's run's is the person's (48 § 15); no other service signs one */
    expect(recordIssue({ kind: "RESEARCH", actor: "service:researcher", suggestionId: null, chapterVersionId: null })).toBeNull();
    expect(recordIssue({ kind: "RESEARCH", actor: CONTRIBUTOR, suggestionId: null, chapterVersionId: null })).toBeNull();
    expect(recordIssue({ kind: "RESEARCH", actor: "service:intake", suggestionId: null, chapterVersionId: null })).toContain("service:researcher or a person");
    /* a reader's deletion of a conversation is the reader's own (45 § 3.7) */
    expect(recordIssue({ kind: "ERASED", actor: "service:researcher", suggestionId: null, chapterVersionId: null })).toContain("the actor of a ERASED record is a person");
    expect(recordIssue({ kind: "ERASED", actor: READER, suggestionId: null, chapterVersionId: null })).toBeNull();
  });

  it("wants a suggestion's record to name the suggestion and the chapter version, and a research record to name neither", () => {
    for (const record of IMPROVE_RECORDS.filter((each) => each.kind !== "RESEARCH")) {
      expect(recordIssue({ ...record, suggestionId: null }), record.kind).toContain("names its suggestion by id");
      expect(recordIssue({ ...record, suggestionId: "the pricing suggestion" }), record.kind).toContain("names its suggestion by id");
      expect(recordIssue({ ...record, chapterVersionId: null }), record.kind).toContain("names the chapter version");
      expect(recordIssue({ ...record, chapterVersionId: "cv-15" }), record.kind).toContain("names the chapter version");
    }
    /* a reader's deletion of a conversation names neither, as a research record does (45 § 3.7) */
    expect(recordIssue({ kind: "ERASED", actor: READER, suggestionId: SUGGESTION_ID, chapterVersionId: null })).toContain("names no suggestion");
    expect(recordIssue({ kind: "ERASED", actor: READER, suggestionId: null, chapterVersionId: CHAPTER_VERSION_ID })).toContain("names no suggestion");
    const research = IMPROVE_RECORDS[6];
    expect(recordIssue({ ...research, suggestionId: SUGGESTION_ID })).toContain("names no suggestion");
    expect(recordIssue({ ...research, chapterVersionId: CHAPTER_VERSION_ID })).toContain("names no suggestion");
  });

  it("leaves an answer's and an export's columns as they have always been", () => {
    expect(recordIssue({ kind: "ANSWER", actor: "00000000-0000-4000-8000-00000000028b", suggestionId: null, chapterVersionId: "cv-21" })).toBeNull();
    expect(recordIssue({ kind: "EXPORT", actor: "service:export", suggestionId: null, chapterVersionId: null })).toBeNull();
  });
});

describe("the characters a payload may carry (Andre, 2026-09-24, unit 38)", () => {
  it("names why jsonb would refuse a string, and stays silent for one it would store", () => {
    expect(unstorableText(SENTENCE)).toBeNull();
    expect(unstorableText("")).toBeNull();
    expect(unstorableText("emoji \u{1F600} and accents: verifica\u00e7\u00e3o")).toBeNull();
    expect(unstorableText("before\u0000after")).toBe("null_character");
    expect(unstorableText("\uD83D")).toBe("lone_surrogate");
    expect(unstorableText("\uDE00")).toBe("lone_surrogate");
    expect(unstorableText("pair \uD83D\uDE00 kept")).toBeNull();
    /* the null character is named first when a string carries both */
    expect(unstorableText("\u0000\uD83D")).toBe("null_character");
  });

  it("walks a payload and gives the path of the first string jsonb would refuse", () => {
    expect(firstUnstorable(ANSWER_PAYLOAD)).toBeNull();
    expect(firstUnstorable({ a: "ok", b: ["fine", "bad\u0000"] })).toEqual({ path: "$.b[1]", reason: "null_character" });
    expect(firstUnstorable({ nested: { deep: "\uDC00" } })).toEqual({ path: "$.nested.deep", reason: "lone_surrogate" });
    expect(firstUnstorable({ "key\u0000": "value" })).toEqual({ path: "$.key\u0000", reason: "null_character" });
    expect(firstUnstorable({ n: 1, b: true, nil: null })).toBeNull();
    expect(firstUnstorable("bad\u0000", "$.payload")).toEqual({ path: "$.payload", reason: "null_character" });
  });

  it("fails the payload schema before the transaction, naming the field", () => {
    expect(LedgerPayloadSchema.safeParse({ kind: "ANSWER", payload: ANSWER_PAYLOAD }).success).toBe(true);

    const withNull = LedgerPayloadSchema.safeParse({ kind: "ANSWER", payload: { ...ANSWER_PAYLOAD, traceId: "trace\u0000id" } });
    expect(withNull.success).toBe(false);
    expect(withNull.error?.issues[0]?.message).toContain("null character");
    expect(withNull.error?.issues[0]?.path).toEqual(["payload"]);

    const withSurrogate = LedgerPayloadSchema.safeParse({ kind: "ANSWER", payload: { ...ANSWER_PAYLOAD, traceId: "trace\uD800id" } });
    expect(withSurrogate.success).toBe(false);
    expect(withSurrogate.error?.issues[0]?.message).toContain("unpaired surrogate");

    /* a Phase 4 kind's loose payload is walked too, although `append` refuses the kind itself */
    expect(LedgerPayloadSchema.safeParse({ kind: "MERGED", payload: { note: "x\u0000" } }).success).toBe(false);
  });
});
