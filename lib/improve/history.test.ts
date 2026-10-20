import { describe, expect, it } from "vitest";

import { ChapterHistorySchema } from "@/lib/schemas/history";

import { bumpBetween, historyOf, layerKindOf, nameOf, type HistoryInput, type MergedInput, type RecordInput } from "./history";

/*
 * A chapter's history as its page tells it (feature-specs/37 § 7; unit 54d), pure: the version ledger newest first
 * from merged suggestions and editorial releases; the summary in the book's words; the override and the inspection;
 * the credit list alphabetical, by consent, and never a ranking (invariants 26 and 27); a researcher's change marked
 * and credited to its endorser; what changed by layer; the stat strip; and the chain check carried through.
 */

const CONTRIBUTOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CURATOR = "33333333-3333-4333-8333-333333333333";
const ENDORSER = "44444444-4444-4444-8444-444444444444";
const HASH = "a".repeat(64);
const AT = new Date("2026-10-10T12:00:00.000Z");

const people: HistoryInput["people"] = new Map([
  [CONTRIBUTOR, { displayName: "T. Osei", consented: true, deleted: false, verified: true }],
  [OTHER, { displayName: "D. Albuquerque", consented: false, deleted: false, verified: false }],
  [CURATOR, { displayName: "M. Tavares", consented: false, deleted: false, verified: true }],
  /* a reader who endorsed a research proposal, not verified: credited, with nothing beside the name (43 § 8) */
  [ENDORSER, { displayName: "K. Nakamura", consented: true, deleted: false, verified: false }],
]);

function merged(over: Partial<MergedInput> & { readonly id: string }): MergedInput {
  return {
    origin: "HUMAN",
    userId: CONTRIBUTOR,
    fromResearch: false,
    changeKind: "EDIT_TEXT",
    changeClass: "WORDING",
    curatorReason: null,
    proposal: { kind: "EDIT_TEXT", before: "Retries are not optional at eleven steps.", after: "Retries are required at eleven steps." },
    score: 80,
    anchor: { kind: "SECTION", sectionAnchor: "21.3", figureAnchor: null, sourceRowAnchor: null, currentText: "Retries are not optional at eleven steps." },
    merge: { versionFrom: "v1.0.0", versionTo: "v1.0.1", bump: "patch", releaseTo: "2026.10", mergedAt: new Date("2026-10-09T22:10:00.000Z"), revertedBy: null },
    adjudication: { decision: "ACCEPT", decidedBy: "adjudicator", score: 80, acceptAt: 70 },
    graded: [{ tier: "B", adjustedScore: 85 }, { tier: "D", adjustedScore: 40 }],
    ...over,
  };
}

/** The records a merged suggestion has, in chain order: its submission, the curator's accept where there was one, the curator's merge, and the merged record. */
function recordsOf(id: string, seq: number, over: { readonly accept?: { readonly overrideCode: string | null; readonly criterion: string | null }; readonly endorsedBy?: string; readonly withdrawn?: boolean; readonly reverts?: string | null; readonly versionTo?: string } = {}): RecordInput[] {
  const curator = (action: string, extra: Record<string, unknown>) => ({ stepKey: "a".repeat(64), rubricVersion: "v1.2", origin: "HUMAN", action, overrideCode: null, criterion: null, noteSha256: null, seeded: false, seedMatched: null, queueWaitMs: 1_000, part: "P2", ...extra });
  return [
    { seq, kind: "SUBMITTED", actor: `user:${CONTRIBUTOR}`, suggestionId: id, payload: {}, hash: HASH },
    ...(over.endorsedBy === undefined ? [] : [{ seq: seq + 1, kind: "ENDORSED", actor: `user:${over.endorsedBy}`, suggestionId: id, payload: { stepKey: "a".repeat(64), consentAt: "2026-10-01T00:00:00.000Z", withdrawn: false }, hash: HASH }]),
    /* a name taken back (42 D4): a second record, and nobody is credited */
    ...(over.endorsedBy === undefined || over.withdrawn !== true ? [] : [{ seq: seq + 1, kind: "ENDORSED", actor: `user:${over.endorsedBy}`, suggestionId: id, payload: { stepKey: "b".repeat(64), consentAt: "2026-10-01T00:00:00.000Z", withdrawn: true }, hash: HASH }]),
    ...(over.accept === undefined ? [] : [{ seq: seq + 2, kind: "CURATOR", actor: `user:${CURATOR}`, suggestionId: id, payload: curator("ACCEPT", over.accept), hash: HASH }]),
    { seq: seq + 3, kind: "CURATOR", actor: `user:${CURATOR}`, suggestionId: id, payload: curator("MERGE", {}), hash: HASH },
    { seq: seq + 4, kind: "MERGED", actor: "service:merge", suggestionId: id, payload: { stepKey: "b".repeat(64), rubricVersion: "v1.2", origin: "HUMAN", branch: `improve/${id}-wording-21-3`, commitSha: "c".repeat(40), versionFrom: "v1.0.0", versionTo: over.versionTo ?? "v1.0.1", bump: "patch", releaseFrom: "2026.09", releaseTo: "2026.10", renderHash: HASH, check: { lab: "PASS", lint: "PASS" }, contributor: `user:${CONTRIBUTOR}`, endorsedBy: over.endorsedBy === undefined || over.withdrawn === true ? null : `user:${over.endorsedBy}`, mergedBy: `user:${CURATOR}`, reverts: over.reverts ?? null }, hash: `${String(seq).padStart(4, "0")}${"d".repeat(60)}` },
  ];
}

const base: HistoryInput = {
  chapter: 21,
  merged: [],
  records: [],
  versions: [{ release: "2026.09", version: "v1.0.0", publishedAt: new Date("2026-09-23T11:09:35.000Z"), sections: 9, verify: "PASSED", lab: "REPRODUCED" }],
  layers: Array.from({ length: 9 }, (_, index) => ({ section: `21.${String(index + 1)}`, title: ["Intuition", "Mechanism", "Worked numbers", "Measurement", "Failure", "Frontier", "Industrial", "Decision aids", "Sources"][index] ?? "" })),
  people,
  chain: { ok: true, records: 0, from: 0, to: 0, firstBreak: null, headHash: null },
  checkedAt: AT,
};

describe("historyOf (37 § 7)", () => {
  it("lists the first release as an editorial major, and a merged change above it, newest first, with its summary in the book's words, its evidence, its people and its record", () => {
    const history = historyOf({ ...base, merged: [merged({ id: "S-21-0001" })], records: recordsOf("S-21-0001", 10), versions: [...base.versions, { release: "2026.10", version: "v1.0.1", publishedAt: new Date("2026-10-09T22:10:00.000Z"), sections: 9, verify: "PASSED", lab: "REPRODUCED" }], chain: { ok: true, records: 4, from: 10, to: 14, firstBreak: null, headHash: HASH } });
    expect(ChapterHistorySchema.safeParse(history).success).toBe(true);
    expect(history.rows.map((row) => `${row.kind} ${row.version} ${row.bump}`)).toEqual(["merged v1.0.1 patch", "editorial v1.0.0 major"]);
    expect(history.rows[0]).toMatchObject({
      kind: "merged",
      at: "2026-10-09T22:10:00.000Z",
      release: "2026.10",
      suggestionId: "S-21-0001",
      changeClass: "WORDING",
      research: false,
      anchor: { kind: "SECTION", id: "21.3", section: "21.3" },
      summary: { quote: "Retries are not optional at eleven steps.", before: "Retries are not optional at eleven steps.", after: "Retries are required at eleven steps." },
      evidence: { tier: "B", score: 80 },
      override: null,
      inspection: false,
      contributor: { name: "T. Osei", pseudonym: `user:${CONTRIBUTOR.slice(0, 8)}`, verified: true },
      curator: { name: "M. Tavares", pseudonym: `user:${CURATOR.slice(0, 8)}`, verified: true },
      record: { seq: 14, hash: `0010${"d".repeat(60)}` },
      reverted: null,
      reverts: null,
    });
    expect(history.rows[1]).toMatchObject({ kind: "editorial", release: "2026.09", sections: 9, verify: "PASSED", lab: "REPRODUCED", at: "2026-09-23T11:09:35.000Z" });
    expect(history).toMatchObject({ chapter: 21, version: "v1.0.1", release: "2026.10", stats: { versions: 2, from: "v1.0.0", to: "v1.0.1", contributed: 1, overrides: { count: 0, latest: null }, reverted: 0 }, chain: { ok: true, records: 4, headHash: HASH } });
    expect(history.credit).toEqual([{ person: { name: "T. Osei", pseudonym: `user:${CONTRIBUTOR.slice(0, 8)}`, verified: true }, accepted: 1, reverted: 0 }]);
    expect(history.layers.find((layer) => layer.section === "21.3")).toEqual({ section: "21.3", title: "Worked numbers", changes: [{ kind: "wording", count: 1 }], reverted: 0, overrides: 0 });
    expect(history.layers.filter((layer) => layer.changes.length > 0)).toHaveLength(1);
  });

  it("names a contributor only while their consent stands, and credits alphabetically by that name, never by count (invariants 26, 27)", () => {
    const rows = [merged({ id: "S-21-0001" }), merged({ id: "S-21-0002", userId: OTHER, merge: { versionFrom: "v1.0.1", versionTo: "v1.0.2", bump: "patch", releaseTo: "2026.10.2", mergedAt: new Date("2026-10-10T08:00:00.000Z"), revertedBy: null } }), merged({ id: "S-21-0003", merge: { versionFrom: "v1.0.2", versionTo: "v1.0.3", bump: "patch", releaseTo: "2026.10.3", mergedAt: new Date("2026-10-10T09:00:00.000Z"), revertedBy: null } })];
    const history = historyOf({ ...base, merged: rows, records: [...recordsOf("S-21-0001", 10), ...recordsOf("S-21-0002", 20), ...recordsOf("S-21-0003", 30)] });
    expect(history.rows.map((row) => row.version)).toEqual(["v1.0.3", "v1.0.2", "v1.0.1", "v1.0.0"]);
    /* the one without consent is the pseudonym; T. Osei has two and still comes after "user:…" by the alphabet alone */
    expect(history.credit).toEqual([
      { person: { name: "T. Osei", pseudonym: `user:${CONTRIBUTOR.slice(0, 8)}`, verified: true }, accepted: 2, reverted: 0 },
      { person: { name: null, pseudonym: `user:${OTHER.slice(0, 8)}`, verified: false }, accepted: 1, reverted: 0 },
    ]);
    expect(history.rows[1]).toMatchObject({ contributor: { name: null, pseudonym: `user:${OTHER.slice(0, 8)}`, verified: false } });
  });

  it("marks a curator's override and an accept on inspection, counts them in the strip, and lays a figure's change under its section", () => {
    const row = merged({ id: "S-21-0004", changeKind: "SET_VALUE", changeClass: "CITED_FIGURE", score: 66, proposal: { kind: "SET_VALUE", after: "0.40", unit: "$" }, anchor: { kind: "FIGURE", sectionAnchor: "21.9", figureAnchor: "F-21-07", sourceRowAnchor: null, currentText: "cached-input price · 0.50 $" }, adjudication: { decision: "REQUEST_MORE", decidedBy: "adjudicator", score: 66, acceptAt: 70 }, graded: [{ tier: "C", adjustedScore: 66 }] });
    const history = historyOf({ ...base, merged: [row], records: recordsOf("S-21-0004", 10, { accept: { overrideCode: "OV-IND-02", criterion: "independence" } }) });
    expect(history.rows[0]).toMatchObject({ kind: "merged", changeKind: "SET_VALUE", anchor: { kind: "FIGURE", id: "F-21-07", section: "21.9" }, summary: { before: "0.50 $", after: "0.40 $" }, evidence: { tier: "C", score: 66 }, override: { code: "OV-IND-02", criterion: "independence" }, inspection: true });
    expect(history.stats.overrides).toEqual({ count: 1, latest: { code: "OV-IND-02", version: "v1.0.1" } });
    expect(history.layers.find((layer) => layer.section === "21.9")).toMatchObject({ changes: [{ kind: "figure", count: 1 }], overrides: 1 });
    /* a curator-always change the adjudicator never saw is accepted on inspection too, with no override */
    const curated = merged({ id: "S-21-0005", changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT", adjudication: null, graded: [] });
    const curatedHistory = historyOf({ ...base, merged: [curated], records: recordsOf("S-21-0005", 20, { accept: { overrideCode: null, criterion: null } }) });
    expect(curatedHistory.rows[0]).toMatchObject({ override: null, inspection: true, evidence: null });
  });

  it("shows a reverted change as such, counts it reverted and not contributed, and shows the revert as a change of nobody's credit (54e)", () => {
    const original = merged({ id: "S-21-0006", merge: { versionFrom: "v1.0.0", versionTo: "v1.0.1", bump: "patch", releaseTo: "2026.10", mergedAt: new Date("2026-10-09T22:10:00.000Z"), revertedBy: "S-21-0007" } });
    const revert = merged({ id: "S-21-0007", userId: null, merge: { versionFrom: "v1.0.1", versionTo: "v1.0.2", bump: "patch", releaseTo: "2026.10.2", mergedAt: new Date("2026-10-10T08:00:00.000Z"), revertedBy: null } });
    const history = historyOf({ ...base, merged: [original, revert], records: [...recordsOf("S-21-0006", 10), ...recordsOf("S-21-0007", 20, { reverts: "S-21-0006", versionTo: "v1.0.2" })] });
    expect(history.rows.map((row) => row.version)).toEqual(["v1.0.2", "v1.0.1", "v1.0.0"]);
    expect(history.rows[0]).toMatchObject({ reverts: "S-21-0006", contributor: null, reverted: null });
    expect(history.rows[1]).toMatchObject({ suggestionId: "S-21-0006", reverted: { by: "S-21-0007", version: "v1.0.2" } });
    expect(history.stats).toMatchObject({ versions: 3, contributed: 0, reverted: 1 });
    expect(history.credit).toEqual([{ person: { name: "T. Osei", pseudonym: `user:${CONTRIBUTOR.slice(0, 8)}`, verified: true }, accepted: 0, reverted: 1 }]);
    expect(history.layers.find((layer) => layer.section === "21.3")).toMatchObject({ changes: [{ kind: "wording", count: 1 }], reverted: 1 });
  });

  it("marks a change that began as research and credits the reader who endorsed it, or nobody (spec 42 § 7); keeps a restructure's description out", () => {
    const researched = merged({ id: "S-21-0008", origin: "RESEARCHER", userId: null, changeKind: "ADD_CLAIM", changeClass: "NEW_CLAIM", proposal: { kind: "ADD_CLAIM", text: "A claim the researcher found.", placeAfter: "end", fastMoving: false } });
    const history = historyOf({ ...base, merged: [researched], records: recordsOf("S-21-0008", 10, { endorsedBy: ENDORSER }) });
    expect(history.rows[0]).toMatchObject({ research: true, contributor: { name: "K. Nakamura" }, summary: { before: null, after: "A claim the researcher found." } });
    expect(history.credit).toEqual([{ person: { name: "K. Nakamura", pseudonym: `user:${ENDORSER.slice(0, 8)}`, verified: false }, accepted: 1, reverted: 0 }]);
    const unendorsed = historyOf({ ...base, merged: [researched], records: recordsOf("S-21-0008", 10) });
    expect(unendorsed.rows[0]).toMatchObject({ research: true, contributor: null });
    expect(unendorsed.credit).toEqual([]);
    /* the merged record's credit stands, whatever a record after it says (42 § 6; unit 59's review) */
    const late = recordsOf("S-21-0008", 10, { endorsedBy: ENDORSER });
    const lateWithdrawal = { ...late[1], seq: 99, payload: { stepKey: "c".repeat(64), consentAt: "2026-10-01T00:00:00.000Z", withdrawn: true } };
    expect(historyOf({ ...base, merged: [researched], records: [...late, lateWithdrawal] }).rows[0]).toMatchObject({ research: true, contributor: { name: "K. Nakamura" } });
    /* a name taken back before the merge credits nobody (42 D4; unit 59d) */
    const withdrawn = historyOf({ ...base, merged: [researched], records: recordsOf("S-21-0008", 10, { endorsedBy: ENDORSER, withdrawn: true }) });
    expect(withdrawn.rows[0]).toMatchObject({ research: true, contributor: null });
    expect(withdrawn.credit).toEqual([]);
    const restructure = merged({ id: "S-21-0009", changeKind: "RESTRUCTURE", changeClass: "CURATOR_ALWAYS", curatorReason: "STRUCTURE", proposal: { kind: "RESTRUCTURE", description: "The contributor's own words about the new section." } });
    expect(historyOf({ ...base, merged: [restructure], records: recordsOf("S-21-0009", 30) }).rows[0]).toMatchObject({ summary: { before: null, after: null }, changeKind: "RESTRUCTURE" });
  });

  it("marks a contributor's draft from a research finding `research` beside the contributor's own credit: provenance, never credit (invariant 27; 48 § 8.6)", () => {
    const drafted = merged({ id: "S-21-0010", fromResearch: true });
    const history = historyOf({ ...base, merged: [drafted], records: recordsOf("S-21-0010", 40, { endorsedBy: ENDORSER }) });
    /* credited to the contributor, never to a reader whose name a record carries */
    expect(history.rows[0]).toMatchObject({ research: true, contributor: { name: "T. Osei" } });
    expect(history.credit.map((entry) => entry.person.name)).toEqual(["T. Osei"]);
    /* a person's ordinary draft has no mark */
    expect(historyOf({ ...base, merged: [merged({ id: "S-21-0011" })], records: recordsOf("S-21-0011", 50) }).rows[0]).toMatchObject({ research: false });
  });

  it("lists an editorial release where the version moved with no merge, and none where it did not; a merge's own version is not editorial", () => {
    const versions = [...base.versions, { release: "2026.10", version: "v1.0.1", publishedAt: new Date("2026-10-09T22:10:00.000Z"), sections: 9, verify: "PASSED", lab: "REPRODUCED" }, { release: "2026.11", version: "v1.0.1", publishedAt: new Date("2026-11-02T10:00:00.000Z"), sections: 9, verify: "PASSED", lab: "REPRODUCED" }, { release: "2026.12", version: "v1.1.0", publishedAt: new Date("2026-12-02T10:00:00.000Z"), sections: 10, verify: "PASSED", lab: null }];
    const history = historyOf({ ...base, merged: [merged({ id: "S-21-0001" })], records: recordsOf("S-21-0001", 10), versions });
    expect(history.rows.map((row) => `${row.kind} ${row.version} ${row.bump} ${row.release}`)).toEqual(["editorial v1.1.0 minor 2026.12", "merged v1.0.1 patch 2026.10", "editorial v1.0.0 major 2026.09"]);
    expect(history.stats).toMatchObject({ versions: 3, from: "v1.0.0", to: "v1.1.0" });
    expect(history.version).toBe("v1.1.0");
  });

  it("names people by consent, bumps by the numbers, and sorts kinds by layer", () => {
    expect(nameOf(`user:${CONTRIBUTOR}`, people, true)).toEqual({ name: "T. Osei", pseudonym: `user:${CONTRIBUTOR.slice(0, 8)}`, verified: true });
    expect(nameOf(`user:${OTHER}`, people, true)).toEqual({ name: null, pseudonym: `user:${OTHER.slice(0, 8)}`, verified: false });
    expect(nameOf(`user:${OTHER}`, people, false)).toEqual({ name: "D. Albuquerque", pseudonym: `user:${OTHER.slice(0, 8)}`, verified: false });
    expect(nameOf(`user:${"9".repeat(8)}-0000-4000-8000-000000000000`, people, false)).toEqual({ name: null, pseudonym: "user:99999999", verified: false });
    expect(nameOf("service:merge", people, false)).toEqual({ name: null, pseudonym: "service:merge", verified: false });
    expect(nameOf(null, people, false)).toBeNull();
    expect([bumpBetween(null, "v1.0.0"), bumpBetween("v1.0.0", "v1.0.1"), bumpBetween("v1.0.1", "v1.1.0"), bumpBetween("v1.1.0", "v2.0.0")]).toEqual(["major", "patch", "minor", "major"]);
    expect(["EDIT_TEXT", "SET_VALUE", "ADD_CLAIM", "ADD_ROW", "EDIT_ROW", "RESTRUCTURE"].map((kind) => layerKindOf(kind as never))).toEqual(["wording", "figure", "claim", "rows", "rows", "section"]);
  });
});
