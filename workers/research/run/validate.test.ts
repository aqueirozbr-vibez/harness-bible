import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";

import type { ConversationRunRow, ResearchSection } from "@/lib/db/research";
import type { ResearchFound } from "@/lib/schemas/researcher";

import { validateRunStep, type ValidateRunDeps } from "./validate";

/*
 * The check of a person's run (feature-specs/48 § 5.5; unit 70b), the rows doubled: a row for every finding, `VALID`
 * or `INVALID` with its reason, the anchor read against the targets' sections; the notes checked and stored as
 * `says` with `notes` removed in the same write and the dropped ones counted; a retried check leaves them as they are;
 * the text gone.
 */

const NOW = new Date("2026-10-12T12:00:00.000Z");
const RUN = { id: "33333333-3333-4333-8333-333333333333", userId: "55555555-5555-4555-8555-555555555555", organisationId: null, conversationId: "44444444-4444-4444-8444-444444444444", ordinal: 1, releaseId: "2026.09", locale: "EN", state: "VALIDATING", skip: null, failure: null, refusal: null, gap: false, sectionAnchors: ["21.3", "21.4"], targetAnchors: ["21.3"], questionSha256: "e".repeat(64), briefSha256: "d".repeat(64), searches: 1, pageReads: 1, workflowId: "research:33333333-3333-4333-8333-333333333333", traceId: "f".repeat(32), textPurgedAt: null, writingAt: null, budgetResetsAt: null, createdAt: NOW } satisfies ConversationRunRow;
const SECTIONS: ReadonlyArray<ResearchSection> = [{ id: "21.3", chapter: 21, version: "v1.0.0", title: "Idempotency keys", text: "A retried write without a key is a second write.", verifiedOn: NOW, figures: [], rows: [] }];
const SEEN = "https://standards.example/keys";
const finding = (anchor: string, source = SEEN) => ({ anchor: { kind: "SECTION", id: anchor }, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: "Keys are kept for 24 hours.", placeAfter: "end", fastMoving: true }, sources: [{ url: source }], note: "The standard says so." });
const FOUND: ResearchFound = {
  findings: [finding("21.3"), finding("21.4"), finding("21.3", "https://unseen.example/")],
  pages: [SEEN],
  notes: [{ url: SEEN, says: "The 2026 revision keeps a key for 24 hours." }, { url: "https://unseen.example/", says: "Retries are safe." }],
  read: [{ url: SEEN, title: "Keys", opened: true, search: 1 }],
};

function harness(found: ResearchFound | null, over: Partial<ValidateRunDeps> = {}) {
  const rows: Array<{ ordinal: number; outcome: string; invalidReason: string | null }> = [];
  const stored: ResearchFound[] = [];
  const asked: Array<ReadonlyArray<string>> = [];
  const deps: ValidateRunDeps = {
    readFound: async () => found,
    readSections: async (_releaseId, anchors) => {
      asked.push(anchors);
      return SECTIONS;
    },
    writeFinding: async (_run, row) => {
      rows.push({ ordinal: row.ordinal, outcome: row.outcome, invalidReason: row.invalidReason });
    },
    writeFound: async (_run, written) => {
      stored.push(written);
      return { written: true };
    },
    log: () => undefined,
    ...over,
  };
  return { deps, rows, stored, asked };
}

describe("validateRunStep", () => {
  it("writes a VALID or INVALID row for every finding, the anchor held to the targets' sections; keeps the notes on pages the turn saw as `says`, removing `notes`, and counts the rest", async () => {
    const run = harness(FOUND);
    expect(await validateRunStep(RUN, run.deps)).toEqual({ valid: 1, invalid: 2 });
    expect(run.asked).toEqual([["21.3"]]);
    expect(run.rows).toEqual([
      { ordinal: 1, outcome: "VALID", invalidReason: null },
      { ordinal: 2, outcome: "INVALID", invalidReason: "ANCHOR" },
      { ordinal: 3, outcome: "INVALID", invalidReason: "SOURCE_NOT_SEEN" },
    ]);
    expect(run.stored).toEqual([{ findings: FOUND.findings, pages: [SEEN], read: FOUND.read, valid: [1], dropped: 0, says: [{ url: SEEN, says: "The 2026 revision keeps a key for 24 hours." }], notesDropped: 1 }]);
    expect(run.stored[0]).not.toHaveProperty("notes");
  });

  it("leaves the kept notes as they are on a retried check, and fails TEXT_PURGED where what the reader found is gone or could not be stored again", async () => {
    const { notes: _notes, ...rest } = FOUND;
    void _notes;
    const retried = harness({ ...rest, valid: [1], dropped: 0, says: [{ url: SEEN, says: "Kept." }], notesDropped: 1 });
    await validateRunStep(RUN, retried.deps);
    expect(retried.stored[0]).toMatchObject({ says: [{ url: SEEN, says: "Kept." }], notesDropped: 1 });
    await expect(validateRunStep(RUN, harness(null).deps)).rejects.toBeInstanceOf(ApplicationFailure);
    await expect(validateRunStep(RUN, harness(FOUND, { writeFound: async () => ({ written: false }) }).deps)).rejects.toMatchObject({ type: "TEXT_PURGED" });
  });
});
