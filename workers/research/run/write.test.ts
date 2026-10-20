import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";

import type { ConversationRunRow, EarlierRun, ResearchSection } from "@/lib/db/research";
import { BudgetExceededError, GatewayUnavailableError } from "@/lib/gateway/errors";
import { loadGuidePart } from "@/lib/guides/load";
import { parseSectionId } from "@/lib/schemas/ids";
import type { Report, ResearchFound } from "@/lib/schemas/researcher";
import type { Written } from "@/workers/agents/researcher/v2/writer";

import { writeRunStep, writerFindingsOf, type WriteRunDeps } from "./write";

/*
 * The write of a person's run (feature-specs/48 § 5.6, § 5.7; unit 70b), the rows and the agent doubled: the writer's
 * slots — the question, the earlier questions and reports, the targets' sections, the findings that passed with their
 * change's before and after, the pages with a note under their numbers — and none of the brief; the report sensor's
 * paragraphs stored; the key's rate and the person's cap answered for the workflow; the agent's failure and a report
 * the sensor left empty, `WRITER_FAILED`; the text gone; and no report stored once the activity's signal fired.
 */

const NOW = new Date("2026-10-12T12:00:00.000Z");
const RUN = { id: "33333333-3333-4333-8333-333333333333", userId: "55555555-5555-4555-8555-555555555555", organisationId: null, conversationId: "44444444-4444-4444-8444-444444444444", ordinal: 2, releaseId: "2026.09", locale: "PT", state: "WRITING", skip: null, failure: null, refusal: null, gap: false, sectionAnchors: ["21.3"], targetAnchors: ["21.3"], questionSha256: "e".repeat(64), briefSha256: "d".repeat(64), searches: 1, pageReads: 1, workflowId: "research:33333333-3333-4333-8333-333333333333", traceId: "f".repeat(32), textPurgedAt: null, writingAt: NOW, budgetResetsAt: null, createdAt: NOW } satisfies ConversationRunRow;
const SECTIONS: ReadonlyArray<ResearchSection> = [
  {
    id: "21.3",
    chapter: 21,
    version: "v1.0.0",
    title: "Idempotency keys",
    text: "A retried write without a key is a second write.",
    verifiedOn: NOW,
    figures: [{ id: "F-21-03", label: "Key retention", valueText: "24", unit: "hours", tier: "PRIMARY", fastMoving: true, verifiedOn: NOW, sourceRow: null }],
    rows: [],
  },
];
const SEEN = "https://standards.example/keys";
const FORUM = "https://forum.example/t/1";
const FOUND: ResearchFound = {
  findings: [
    { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: "Keys are kept for 24 hours.", placeAfter: "end", fastMoving: true }, sources: [{ url: SEEN }], note: "The standard says so." },
    { anchor: { kind: "FIGURE", id: "F-21-03" }, changeKind: "SET_VALUE", proposal: { kind: "SET_VALUE", after: "48", unit: "hours" }, sources: [{ url: SEEN }], note: "Doubled in 2026." },
  ],
  pages: [SEEN, FORUM],
  read: [
    { url: FORUM, title: "Forum", opened: false, search: 1 },
    { url: SEEN, title: "Keys", opened: true, search: 1 },
  ],
  valid: [1, 2],
  says: [{ url: SEEN, says: "The 2026 revision keeps a key for 48 hours." }],
};
const EARLIER: ReadonlyArray<EarlierRun> = [{ ordinal: 1, question: "How long is a key kept?", brief: "Look for the retention window.", report: { paragraphs: [{ text: "The pages read give 24 hours [1].", sections: [], pages: [1] }], dropped: {} }, targetAnchors: ["21.3"] }];
const S213 = parseSectionId("21.3");

function harness(answer: Written | Error, over: Partial<WriteRunDeps> = {}) {
  const calls: Array<Parameters<WriteRunDeps["write"]>[0]> = [];
  const stored: Report[] = [];
  const deps: WriteRunDeps = {
    guide: () => loadGuidePart("researcher", "v2.0", "writer"),
    rubric: async () => null,
    readQuestion: async () => "E as chaves duram quanto tempo?",
    readFound: async () => FOUND,
    readEarlier: async () => EARLIER,
    readSections: async () => SECTIONS,
    write: async (input) => {
      calls.push(input);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    writer: { gateway: {} as WriteRunDeps["writer"]["gateway"] },
    writeReport: async (_run, report) => {
      stored.push(report);
      return { written: true };
    },
    log: () => undefined,
    ...over,
  };
  return { deps, calls, stored };
}

const answered = (paragraphs: Extract<Written, { ok: true }>["output"]["paragraphs"]): Written => ({ ok: true, output: { paragraphs }, model: "claude-opus-5", usage: null, promptSha256: "a".repeat(64) });

describe("writerFindingsOf", () => {
  it("reads the findings that passed, each with its section and its change's before and after as changeOf computes them", () => {
    expect(writerFindingsOf(FOUND, SECTIONS)).toEqual([
      { section: "21.3", anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM", before: null, after: "Keys are kept for 24 hours.", note: "The standard says so." },
      { section: "21.3", anchor: { kind: "FIGURE", id: "F-21-03" }, changeKind: "SET_VALUE", before: "24 hours", after: "48 hours", note: "Doubled in 2026." },
    ]);
    expect(writerFindingsOf({ ...FOUND, valid: [2] }, SECTIONS).map((finding) => finding.anchor.id)).toEqual(["F-21-03"]);
    expect(writerFindingsOf({ ...FOUND, valid: undefined }, SECTIONS)).toEqual([]);
  });
});

describe("writeRunStep", () => {
  it("gives the writer its slots and nothing of the brief; stores the paragraphs the sensor kept and counts the ones it dropped", async () => {
    const run = harness(answered([
      { text: "As páginas lidas dão 48 horas [2].", sections: [S213], pages: [2] },
      { text: "A página [1] não tem nota.", sections: [], pages: [1] },
    ]));
    expect(await writeRunStep(RUN, run.deps)).toEqual({ written: "report", findings: 2, paragraphs: 1, dropped: 1 });
    expect(run.calls[0].call).toEqual({ principal: { userId: RUN.userId }, traceId: RUN.traceId, ref: RUN.id });
    expect(run.calls[0].prompt).toMatchObject({ language: "PT", question: "E as chaves duram quanto tempo?", earlier: [{ question: "How long is a key kept?", report: ["The pages read give 24 hours [1]."] }], pages: [{ n: 2, says: "The 2026 revision keeps a key for 48 hours." }] });
    expect(JSON.stringify(run.calls[0].prompt)).not.toContain("retention window");
    expect(run.stored).toEqual([{ paragraphs: [{ text: "As páginas lidas dão 48 horas [2].", sections: ["21.3"], pages: [2] }], dropped: { PAGE: 1 } }]);
  });

  it("answers the key's rate limit and the person's cap for the workflow, storing nothing", async () => {
    const limited = harness(new GatewayUnavailableError("rate_limit", "429 at the key's rate"));
    expect(await writeRunStep(RUN, limited.deps)).toEqual({ written: "rate_limit" });
    const resetsAt = new Date("2026-11-01T00:00:00.000Z");
    expect(await writeRunStep(RUN, harness(new BudgetExceededError(resetsAt, "Budget has been exceeded!")).deps)).toEqual({ written: "budget", resetsAt });
    expect(limited.stored).toEqual([]);
  });

  it("fails WRITER_FAILED on the agent's failure and on a report the sensor left empty, TEXT_PURGED where the text is gone", async () => {
    await expect(writeRunStep(RUN, harness({ ok: false, failure: "the writer's output is not JSON", model: null, usage: null, promptSha256: "a".repeat(64) }).deps)).rejects.toMatchObject({ type: "WRITER_FAILED" });
    const empty = harness(answered([{ text: "See https://standards.example/keys for it [2].", sections: [], pages: [2] }]));
    await expect(writeRunStep(RUN, empty.deps)).rejects.toMatchObject({ type: "WRITER_FAILED" });
    expect(empty.stored).toEqual([]);
    await expect(writeRunStep(RUN, harness(answered([]), { readQuestion: async () => null }).deps)).rejects.toBeInstanceOf(ApplicationFailure);
    await expect(writeRunStep(RUN, harness(answered([{ text: "A paragraph [2].", sections: [], pages: [2] }]), { writeReport: async () => ({ written: false }) }).deps)).rejects.toMatchObject({ type: "TEXT_PURGED" });
  });

  it("stores no report once the activity's signal fired while the writer ran, failing CANCELLED (48 § 5.1; review of unit 70)", async () => {
    const controller = new AbortController();
    const run = harness(answered([{ text: "As páginas lidas dão 48 horas [2].", sections: [S213], pages: [2] }]), {
      write: async () => {
        controller.abort();
        return answered([{ text: "As páginas lidas dão 48 horas [2].", sections: [S213], pages: [2] }]);
      },
    });
    await expect(writeRunStep(RUN, run.deps, controller.signal)).rejects.toMatchObject({ type: "CANCELLED" });
    expect(run.stored).toEqual([]);
  });
});
