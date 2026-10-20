import { z } from "zod";

import { EvidenceTierSchema } from "@/lib/schemas/domain";
import { ChapterNumberSchema, ReleaseIdSchema, SectionIdSchema, SuggestionIdSchema } from "@/lib/schemas/ids";
import { AnchorKindSchema, ChangeClassSchema, ChangeKindSchema, CriterionSchema, CuratorReasonSchema } from "@/lib/schemas/improve";

/*
 * A chapter's improvement history (feature-specs/37 § 7; unit 54d), as `GET /api/v1/chapters/{n}/history` answers it
 * and the Chapter-History page draws it: the version ledger, newest first; the stat strip; the credit list, alphabetical
 * (invariant 26); what changed by layer; and the chain check over the chapter's records. Public: every merged
 * suggestion's record is anyone's (35 D2). A person is named only while their consent stands (invariant 27), else by
 * the ledger's pseudonym; a researcher's change carries its mark and credits the reader who endorsed it, or nobody.
 */

const VersionSchema = z.string().regex(/^v\d+\.\d+\.\d+$/);
const BumpSchema = z.enum(["patch", "minor", "major"]);
/**
 * A person as the history names them: by name while their consent stands, else by the ledger's pseudonym, shortened;
 * and whether their identity was verified — a reader who endorsed a researcher's proposal may not have been, and the
 * history says `verified` beside a verified name and nothing beside the others (feature-specs/43 § 8; unit 60e).
 */
const PersonSchema = z.strictObject({ name: z.string().nullable(), pseudonym: z.string().nullable(), verified: z.boolean() });
export type HistoryPerson = z.infer<typeof PersonSchema>;

/** What a merged change did, in the book's own words: the anchor's quote, and the text before and after. Never a rationale. */
const SummarySchema = z.strictObject({ quote: z.string(), before: z.string().nullable(), after: z.string().nullable() });

const MergedRowSchema = z.strictObject({
  kind: z.literal("merged"),
  version: VersionSchema,
  bump: BumpSchema,
  /** When it merged. */
  at: z.iso.datetime(),
  release: ReleaseIdSchema,
  suggestionId: SuggestionIdSchema,
  changeKind: ChangeKindSchema,
  changeClass: ChangeClassSchema,
  curatorReason: CuratorReasonSchema.nullable(),
  /** The change began as research (spec 42 § 7): the mark says where it came from; credit is a person's. */
  research: z.boolean(),
  anchor: z.strictObject({ kind: AnchorKindSchema, id: z.string(), section: SectionIdSchema }),
  summary: SummarySchema,
  /** The strongest graded item's tier and the suggestion's score; null where nothing was graded. */
  evidence: z.strictObject({ tier: EvidenceTierSchema, score: z.int().nonnegative() }).nullable(),
  /** The curator's accept against the adjudicator (36 § 5.2), when it was one. */
  override: z.strictObject({ code: z.string(), criterion: CriterionSchema.nullable() }).nullable(),
  /** Accepted on a curator's inspection: the adjudicator had it under the acceptance, or had not decided it. */
  inspection: z.boolean(),
  /** The contributor; for a researcher's change, the reader who endorsed it, or nobody. */
  contributor: PersonSchema.nullable(),
  /** The curator who merged it. */
  curator: PersonSchema,
  /** The `merged` record: its place in the chain and its hash. */
  record: z.strictObject({ seq: z.int().positive(), hash: z.string().regex(/^[0-9a-f]{64}$/) }).nullable(),
  /** Reverted later (54e): by which suggestion, in which version. */
  reverted: z.strictObject({ by: SuggestionIdSchema, version: VersionSchema.nullable() }).nullable(),
  /** This change is a revert of another (54e). */
  reverts: SuggestionIdSchema.nullable(),
});
export type MergedHistoryRow = z.infer<typeof MergedRowSchema>;

/** A release in which the chapter's version moved with no suggestion merged: an editorial release, the first among them. */
const EditorialRowSchema = z.strictObject({
  kind: z.literal("editorial"),
  version: VersionSchema,
  bump: BumpSchema,
  at: z.iso.datetime(),
  release: ReleaseIdSchema,
  sections: z.int().nonnegative(),
  verify: z.string(),
  lab: z.string().nullable(),
});
export type EditorialHistoryRow = z.infer<typeof EditorialRowSchema>;

export const HistoryRowSchema = z.discriminatedUnion("kind", [MergedRowSchema, EditorialRowSchema]);
export type HistoryRow = z.infer<typeof HistoryRowSchema>;

/** What a change is counted as, by layer: the kind's word. */
export const LAYER_CHANGE_KINDS = ["wording", "figure", "claim", "rows", "section"] as const;
export const LayerChangeKindSchema = z.enum(LAYER_CHANGE_KINDS);
export type LayerChangeKind = z.infer<typeof LayerChangeKindSchema>;

export const ChapterHistorySchema = z.strictObject({
  chapter: ChapterNumberSchema,
  /** The chapter's current version, and the release that holds it. */
  version: VersionSchema,
  release: ReleaseIdSchema,
  /** Newest first. */
  rows: z.array(HistoryRowSchema),
  stats: z.strictObject({
    versions: z.int().nonnegative(),
    from: VersionSchema.nullable(),
    to: VersionSchema,
    /** Merged changes still in the text: not reverted. */
    contributed: z.int().nonnegative(),
    overrides: z.strictObject({ count: z.int().nonnegative(), latest: z.strictObject({ code: z.string(), version: VersionSchema }).nullable() }),
    reverted: z.int().nonnegative(),
  }),
  /** Alphabetical by how each is named, and nothing else (invariant 26): accepted changes still in the text, and reverted ones. */
  credit: z.array(z.strictObject({ person: PersonSchema, accepted: z.int().nonnegative(), reverted: z.int().nonnegative() })),
  /** Each layer of the current version, with the merged changes it took, by kind, and how many were reverted or accepted on an override. */
  layers: z.array(z.strictObject({ section: SectionIdSchema, title: z.string(), changes: z.array(z.strictObject({ kind: LayerChangeKindSchema, count: z.int().positive() })), reverted: z.int().nonnegative(), overrides: z.int().nonnegative() })),
  chain: z.strictObject({ ok: z.boolean(), records: z.int().nonnegative(), headHash: z.string().nullable(), firstBreak: z.strictObject({ seq: z.int(), field: z.string() }).nullable() }),
  checkedAt: z.iso.datetime(),
});
export type ChapterHistory = z.infer<typeof ChapterHistorySchema>;

export const ChapterHistoryParamsSchema = z.strictObject({ n: z.string().regex(/^\d{2}$/, "a chapter number as two digits") });
