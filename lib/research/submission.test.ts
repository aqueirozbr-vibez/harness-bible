import { describe, expect, it } from "vitest";

import type { ResolvedAnchor } from "@/lib/db/anchors";
import type { ReaderFinding } from "@/lib/schemas/researcher";

import { findingKeyOf, findingSourcesOf, sourcesNotAmong, submissionOf } from "./submission";

/*
 * What a finding becomes in Improve (feature-specs/42 § 4; feature-specs/48 § 8.2, § 8.4; moved here in unit 74): the
 * class from the passage and the proposed text, the parts of the anchor and its readers, the key over the anchor's
 * content, the note, the https sources once each — one computation for a contributor's draft and a researcher's
 * proposal, so the duplicate check compares like with like; and the sources a draft's evidence does not hold.
 */

const NOW = new Date("2026-10-10T12:00:00.000Z");
const RESOLVED: ResolvedAnchor = {
  kind: "SECTION",
  chapterNumber: 21,
  chapterVersionId: "cv-21",
  chapterVersion: "v1.0.0",
  releaseId: "2026.09",
  part: "P3",
  sectionAnchor: "21.3",
  figureAnchor: null,
  sourceRowAnchor: null,
  currentText: "A retried write without a key is a second write. Keep the key for 24 hours.",
  contentSha256: "c".repeat(64),
  figures: [],
  value: null,
  row: null,
  tier: null,
  verifiedOn: null,
  fastMoving: false,
  scenarioParam: false,
  readBy: [{ section: "23.1", title: "Gateways", chapterNumber: 23, part: "P4" }],
};
const finding = (over: Partial<ReaderFinding> = {}): ReaderFinding => ({ anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: "Keys are kept for at least 24 hours after the first response.", placeAfter: "end", fastMoving: true }, sources: [{ url: "https://standards.example/keys" }, { url: " https://standards.example/keys " }, { url: "http://plain.example/" }], note: "The standard says so.", ...over });

describe("submissionOf", () => {
  it("builds a researcher's submission: the class from the passage and the text, the anchor's parts and its readers', the key over the content, the note, the https sources once each with their hosts", () => {
    const submission = submissionOf(finding(), RESOLVED, "v1.2", "EN", NOW);
    expect(submission).toMatchObject({ chapterNumber: 21, chapterVersionId: "cv-21", releaseId: "2026.09", parts: ["P3", "P4"], changeKind: "ADD_CLAIM", changeClass: "NEW_CLAIM", curatorReason: null, locale: "EN", rubricVersionId: "v1.2", note: "The standard says so.", now: NOW });
    expect(submission.anchor).toEqual({ kind: "SECTION", sectionAnchor: "21.3", figureAnchor: null, sourceRowAnchor: null, currentText: RESOLVED.currentText, contentSha256: "c".repeat(64), existsAtVersion: true });
    expect(submission.sources).toEqual([{ url: "https://standards.example/keys", host: "standards.example" }]);
    expect(submission.proposalKey).toMatch(/^[0-9a-f]{64}$/);
    expect(submission.workflowIdOf("S-21-0101")).toBe("suggestion:S-21-0101");
    /* the same proposal at the same text has one key; another text another */
    expect(submissionOf(finding(), RESOLVED, "v1.2", "EN", NOW).proposalKey).toBe(submission.proposalKey);
    expect(submissionOf(finding(), { ...RESOLVED, contentSha256: "a".repeat(64) }, "v1.2", "EN", NOW).proposalKey).not.toBe(submission.proposalKey);
  });

  it("sends a restructure, and a passage about operating equipment, to a curator", () => {
    expect(submissionOf(finding({ changeKind: "RESTRUCTURE", proposal: { kind: "RESTRUCTURE", description: "Split the section." } }), RESOLVED, "v1.2", "EN", NOW)).toMatchObject({ changeClass: "CURATOR_ALWAYS", curatorReason: "STRUCTURE" });
  });
});

describe("a finding's key and sources", () => {
  it("keys a finding as its submission does, so a draft and a send of it are the same change to the duplicate check (48 § 8.5)", () => {
    expect(findingKeyOf(finding(), RESOLVED)).toBe(submissionOf(finding(), RESOLVED, "v1.2", "PT", NOW).proposalKey);
    expect(findingKeyOf(finding({ note: "another note, another source" , sources: [{ url: "https://other.example/" }] }), RESOLVED)).toBe(findingKeyOf(finding(), RESOLVED));
    expect(findingKeyOf(finding(), { ...RESOLVED, contentSha256: "b".repeat(64) })).not.toBe(findingKeyOf(finding(), RESOLVED));
  });

  it("keeps the https sources, trimmed and each once, in the reader's order", () => {
    expect(findingSourcesOf(finding({ sources: [{ url: "https://b.example/x" }, { url: "http://a.example/" }, { url: " https://b.example/x" }, { url: "https://A.example/y" }] }))).toEqual([
      { url: "https://b.example/x", host: "b.example" },
      { url: "https://A.example/y", host: "a.example" },
    ]);
  });

  it("lists the sources no item of a draft holds, an item's address trimmed, an upload's none (48 § 8.2)", () => {
    const sources = [
      { url: "https://a.example/1", host: "a.example" },
      { url: "https://b.example/2", host: "b.example" },
    ];
    expect(sourcesNotAmong(sources, [{ url: " https://a.example/1 " }, { url: null }])).toEqual([{ url: "https://b.example/2", host: "b.example" }]);
    expect(sourcesNotAmong(sources, [])).toEqual(sources);
    expect(sourcesNotAmong(sources, [{ url: "https://b.example/2" }, { url: "https://a.example/1" }])).toEqual([]);
  });
});
