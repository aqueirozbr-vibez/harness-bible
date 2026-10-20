import { endorserOf } from "@/lib/improve/endorsement";
import { changeOf } from "@/lib/improve/outcomeView";
import { versionAfter } from "@/lib/improve/merge";
import type { ChainCheck } from "@/lib/ledger/verify";
import { CuratorPayloadSchema, MergedPayloadSchema } from "@/lib/schemas/ledger";
import type { ChapterHistory, EditorialHistoryRow, HistoryPerson, HistoryRow, LayerChangeKind, MergedHistoryRow } from "@/lib/schemas/history";
import type { ChapterNumber, ReleaseId, SectionId, SuggestionId } from "@/lib/schemas/ids";
import type { AnchorKind, ChangeClass, ChangeKind, Criterion, CuratorReason, Decision, SuggestionOrigin } from "@/lib/schemas/improve";
import type { Proposal } from "@/lib/schemas/improve";
import type { EvidenceTier } from "@/lib/schemas/domain";

/*
 * A chapter's improvement history as its page tells it (feature-specs/37 § 7; unit 54d), pure: from the chapter's
 * merged suggestions, their records, the chapter's versions by release, and the people as the viewer may name them,
 * to the version ledger newest first, the stat strip, the credit list in alphabetical order (invariant 26), what
 * changed by layer, and the chain check. Every fact is a row's or a payload's own: a summary quotes the book's text
 * the proposal holds, never a rationale, and a restructure's description — the contributor's words — is left out.
 */

/** A merged suggestion as the loader hands it over: the door's row, flattened. */
export interface MergedInput {
  readonly id: string;
  readonly origin: SuggestionOrigin;
  readonly userId: string | null;
  /** A contributor's draft from a research finding (feature-specs/48 § 8.6): marked `research`, credited to the contributor. */
  readonly fromResearch: boolean;
  readonly changeKind: ChangeKind;
  readonly changeClass: ChangeClass;
  readonly curatorReason: CuratorReason | null;
  readonly proposal: Proposal | null;
  readonly score: number | null;
  readonly anchor: { readonly kind: AnchorKind; readonly sectionAnchor: string; readonly figureAnchor: string | null; readonly sourceRowAnchor: string | null; readonly currentText: string } | null;
  readonly merge: { readonly versionFrom: string; readonly versionTo: string | null; readonly bump: string; readonly releaseTo: string | null; readonly mergedAt: Date | null; readonly revertedBy: string | null };
  readonly adjudication: { readonly decision: Decision; readonly decidedBy: string; readonly score: number; readonly acceptAt: number | null } | null;
  readonly graded: ReadonlyArray<{ readonly tier: EvidenceTier | null; readonly adjustedScore: number | null }>;
}

/** A record of the chapter's view, as the ledger holds it. */
export interface RecordInput {
  readonly seq: number;
  readonly kind: string;
  readonly actor: string;
  readonly suggestionId: string | null;
  readonly payload: unknown;
  readonly hash: string;
}

/** The chapter's version in each release, oldest release first. */
export interface VersionInput {
  readonly release: string;
  readonly version: string;
  readonly publishedAt: Date;
  readonly sections: number;
  readonly verify: string;
  readonly lab: string | null;
}

/** A person by id, as the viewer may see them: the name while consent stands and the account is there, else nothing. */
export type People = ReadonlyMap<string, { readonly displayName: string; readonly consented: boolean; readonly deleted: boolean; readonly verified?: boolean }>;

export interface HistoryInput {
  readonly chapter: number;
  readonly merged: ReadonlyArray<MergedInput>;
  readonly records: ReadonlyArray<RecordInput>;
  readonly versions: ReadonlyArray<VersionInput>;
  /** The current version's layers, in order, with their titles. */
  readonly layers: ReadonlyArray<{ readonly section: string; readonly title: string }>;
  readonly people: People;
  readonly chain: ChainCheck;
  readonly checkedAt: Date;
}

const TIERS: ReadonlyArray<EvidenceTier> = ["A", "B", "C", "D", "E", "G", "U"];

/** `user:<id>`'s id, or null for a service. */
const personOf = (actor: string): string | null => (actor.startsWith("user:") ? actor.slice("user:".length) : null);

/** A person as the history names them: by name while their consent stands and their account is there, else by the pseudonym's short form; null for no one. */
export function nameOf(actor: string | null, people: People, consentGoverns: boolean): HistoryPerson | null {
  if (actor === null) return null;
  const id = personOf(actor);
  if (id === null) return { name: null, pseudonym: actor, verified: false };
  const person = people.get(id);
  const named = person !== undefined && !person.deleted && (!consentGoverns || person.consented);
  return { name: named ? person.displayName : null, pseudonym: actor.slice(0, "user:".length + 8), verified: named && person.verified === true };
}

/** The kind's bump between two versions, by their numbers; a first version is a major. */
export function bumpBetween(previous: string | null, version: string): "patch" | "minor" | "major" {
  const of = (text: string): [number, number, number] => {
    const parts = /^v(\d+)\.(\d+)\.(\d+)$/.exec(text);
    return parts === null ? [0, 0, 0] : [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  };
  if (previous === null) return "major";
  const [a, b] = [of(previous), of(version)];
  if (a[0] !== b[0]) return "major";
  return a[1] !== b[1] ? "minor" : "patch";
}

/** What a change counts as by layer (the screen's "1 wording", "2 rows"). */
export function layerKindOf(kind: ChangeKind): LayerChangeKind {
  switch (kind) {
    case "EDIT_TEXT":
      return "wording";
    case "SET_VALUE":
      return "figure";
    case "ADD_CLAIM":
      return "claim";
    case "ADD_ROW":
    case "EDIT_ROW":
      return "rows";
    case "RESTRUCTURE":
      return "section";
  }
}

/** The strongest graded item's tier, and the suggestion's score. */
function evidenceOf(input: MergedInput): MergedHistoryRow["evidence"] {
  const tiers = input.graded.flatMap((item) => (item.tier === null ? [] : [item.tier]));
  if (tiers.length === 0 || input.score === null) return null;
  const strongest = TIERS.find((tier) => tiers.includes(tier)) ?? tiers[0];
  return { tier: strongest, score: input.score };
}

/** The book's own before and after; a restructure's description is the contributor's, and stays out. */
function summaryOf(input: MergedInput): MergedHistoryRow["summary"] {
  if (input.anchor === null) return { quote: "", before: null, after: null };
  if (input.proposal?.kind === "RESTRUCTURE") return { quote: input.anchor.currentText.slice(0, 280), before: null, after: null };
  return changeOf({ anchor: input.anchor, proposal: input.proposal });
}

export function historyOf(input: HistoryInput): ChapterHistory {
  const byId = new Map(input.merged.map((row) => [row.id, row]));
  /* each suggestion's records: its merged record, the curator's accept and its override, who merged it, who endorsed it */
  const recordsOf = (id: string) => input.records.filter((record) => record.suggestionId === id);
  const merged: MergedHistoryRow[] = input.merged.flatMap((row) => {
    const records = recordsOf(row.id);
    const mergedRecord = [...records].reverse().find((record) => record.kind === "MERGED") ?? null;
    const mergedPayload = mergedRecord === null ? null : MergedPayloadSchema.safeParse(mergedRecord.payload);
    const curatorRecords = records.filter((record) => record.kind === "CURATOR").map((record) => ({ actor: record.actor, payload: CuratorPayloadSchema.safeParse(record.payload) }));
    const accept = [...curatorRecords].reverse().find((record) => record.payload.success && record.payload.data.action === "ACCEPT") ?? null;
    const merge = [...curatorRecords].reverse().find((record) => record.payload.success && record.payload.data.action === "MERGE") ?? null;
    /* the credit as the merged record wrote it (42 § 6: after the merged record, credit is written); the records' latest name where it does not read */
    const endorser = mergedPayload?.success === true ? mergedPayload.data.endorsedBy : endorserOf(records);
    const override = accept !== null && accept.payload.success && accept.payload.data.overrideCode !== null ? { code: accept.payload.data.overrideCode, criterion: accept.payload.data.criterion as Criterion | null } : null;
    /* a curator's accept of what the adjudicator had under the acceptance, or had not decided: accepted on inspection */
    const inspection = accept !== null && (row.adjudication === null || row.adjudication.decision !== "ACCEPT");
    const version = row.merge.versionTo ?? (mergedPayload?.success ? mergedPayload.data.versionTo : versionAfter(row.merge.versionFrom, row.merge.bump === "minor" || row.merge.bump === "major" ? row.merge.bump : "patch"));
    const release = row.merge.releaseTo ?? (mergedPayload?.success ? mergedPayload.data.releaseTo : null);
    const mergedAt = row.merge.mergedAt;
    if (release === null || mergedAt === null || row.anchor === null) return [];
    /* the `research` mark is provenance, never credit (invariant 27; 48 § 8.6): a researcher's proposal is credited to the
       reader who added their name, if one did, and a contributor's draft from a finding to the contributor */
    const researcher = row.origin === "RESEARCHER";
    const research = researcher || row.fromResearch;
    const contributor = researcher ? (endorser === null ? null : nameOf(endorser, input.people, true)) : nameOf(row.userId === null ? null : `user:${row.userId}`, input.people, true);
    const curator = nameOf(merge?.actor ?? (mergedPayload?.success ? mergedPayload.data.mergedBy : null), input.people, false) ?? { name: null, pseudonym: null, verified: false };
    const revertedBy = row.merge.revertedBy;
    const revert = revertedBy === null ? null : (byId.get(revertedBy) ?? null);
    const bump = mergedPayload?.success ? mergedPayload.data.bump : row.merge.bump === "minor" || row.merge.bump === "major" ? row.merge.bump : "patch";
    return [
      {
        kind: "merged" as const,
        version,
        bump,
        at: mergedAt.toISOString(),
        release: release as ReleaseId,
        suggestionId: row.id as SuggestionId,
        changeKind: row.changeKind,
        changeClass: row.changeClass,
        curatorReason: row.curatorReason,
        research,
        anchor: { kind: row.anchor.kind, id: row.anchor.figureAnchor ?? row.anchor.sourceRowAnchor ?? row.anchor.sectionAnchor, section: row.anchor.sectionAnchor as SectionId },
        summary: summaryOf(row),
        evidence: evidenceOf(row),
        override,
        inspection,
        contributor,
        curator,
        record: mergedRecord === null ? null : { seq: mergedRecord.seq, hash: mergedRecord.hash },
        reverted: revertedBy === null ? null : { by: revertedBy as SuggestionId, version: revert?.merge.versionTo ?? null },
        reverts: mergedPayload?.success ? mergedPayload.data.reverts : null,
      } satisfies MergedHistoryRow,
    ];
  });

  /* editorial releases: the chapter's version moved with no merge making it (the first release among them) */
  const mergedVersions = new Set(merged.map((row) => `${row.release}|${row.version}`));
  const editorial: EditorialHistoryRow[] = [];
  let previous: string | null = null;
  for (const entry of input.versions) {
    if (entry.version !== previous && !mergedVersions.has(`${entry.release}|${entry.version}`)) {
      editorial.push({ kind: "editorial", version: entry.version, bump: bumpBetween(previous, entry.version), at: entry.publishedAt.toISOString(), release: entry.release as ReleaseId, sections: entry.sections, verify: entry.verify, lab: entry.lab });
    }
    previous = entry.version;
  }

  const rows: HistoryRow[] = [...merged, ...editorial].sort((a, b) => b.at.localeCompare(a.at) || b.version.localeCompare(a.version, undefined, { numeric: true }));
  const current = input.versions.at(-1);
  const standing = merged.filter((row) => row.reverted === null && row.reverts === null);
  const overridden = merged.filter((row) => row.override !== null);
  const latestOverride = [...overridden].sort((a, b) => b.at.localeCompare(a.at))[0];

  /* credit: by the person each change is credited to, alphabetical by how they are named, and nothing else (invariant 26) */
  const credit = new Map<string, { readonly person: HistoryPerson; accepted: number; reverted: number }>();
  for (const row of merged) {
    if (row.contributor === null || row.reverts !== null) continue;
    const key = row.contributor.name ?? row.contributor.pseudonym ?? "";
    const entry = credit.get(key) ?? { person: row.contributor, accepted: 0, reverted: 0 };
    if (row.reverted === null) entry.accepted += 1;
    else entry.reverted += 1;
    credit.set(key, entry);
  }

  const layers = input.layers.map((layer) => {
    const here = merged.filter((row) => row.anchor.section === layer.section && row.reverts === null);
    const counts = new Map<LayerChangeKind, number>();
    for (const row of here) counts.set(layerKindOf(row.changeKind), (counts.get(layerKindOf(row.changeKind)) ?? 0) + 1);
    return { section: layer.section as SectionId, title: layer.title, changes: [...counts].map(([kind, count]) => ({ kind, count })), reverted: here.filter((row) => row.reverted !== null).length, overrides: here.filter((row) => row.override !== null).length };
  });

  return {
    chapter: input.chapter as ChapterNumber,
    version: current?.version ?? rows[0]?.version ?? "v1.0.0",
    release: (current?.release ?? rows[0]?.release ?? "") as ReleaseId,
    rows,
    stats: {
      versions: rows.length,
      from: rows.at(-1)?.version ?? null,
      to: current?.version ?? rows[0]?.version ?? "v1.0.0",
      contributed: standing.length,
      overrides: { count: overridden.length, latest: latestOverride === undefined || latestOverride.override === null ? null : { code: latestOverride.override.code, version: latestOverride.version } },
      reverted: merged.filter((row) => row.reverted !== null).length,
    },
    credit: [...credit.values()].sort((a, b) => (a.person.name ?? a.person.pseudonym ?? "").localeCompare(b.person.name ?? b.person.pseudonym ?? "", undefined, { sensitivity: "base" })),
    layers,
    chain: { ok: input.chain.ok, records: input.chain.records, headHash: input.chain.headHash, firstBreak: input.chain.firstBreak === null ? null : { seq: input.chain.firstBreak.seq, field: input.chain.firstBreak.field } },
    checkedAt: input.checkedAt.toISOString(),
  };
}
