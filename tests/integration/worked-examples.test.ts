import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveAnchor } from "@/lib/db/anchors";
import { readSuggestionAsService, type ServiceCaller } from "@/lib/db/improve";
import { neighbours, range, toChainRecord, view } from "@/lib/db/ledger";
import { env } from "@/lib/env";
import { gradedItemsOf } from "@/lib/improve/scoring";
import { verifyChain } from "@/lib/ledger/verify";
import { wouldSuffice } from "@/lib/rubric/score";
import { loadRubric } from "@/lib/rubrics/load";
import type { SuggestionId } from "@/lib/schemas/ids";
import { mergeWorkflowId, SUGGESTION_WORKFLOW, SuggestionWorkflowResultSchema, suggestionWorkflowId, type MergeStage, type SuggestionWaits, type SuggestionWorkflowResult } from "@/lib/schemas/workflows";
import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import { WORKED_EXAMPLES, type WorkedExample } from "@/tests/fixtures/improve/examples";
import { clearExampleAccount, draftExample, exampleActivities, mergeWaitingOf, signInContributor, startStubGateway, waitingOf, type ExampleContributor, type StubGateway } from "@/tests/fixtures/improve/harness";
import { workflowEnvironment } from "@/tests/workflows/environment";

/*
 * The four worked examples of feature-specs/33 § 8, end to end (§ 11.1, § 11.2; unit 50g), the Phase 4 gate's first
 * criterion. Each is drafted as a person drafts one, through the create and patch endpoints, on what release 2026.09
 * holds (tests/fixtures/improve/examples.ts says which anchors, and why where the PRD's place holds none); its evidence
 * is added and left pending; and the real workflow runs it on Temporal's test server with its real activities, against
 * the database, the policy sidecar, the store, the book where it is kept, the stub gateway started in this process and a
 * fetcher given the fixture's documents. Each must end where § 8 says — its state, its score, the decision and who made
 * it — with its four records in order and the chain verified from the first of them to the last. A run that ends where
 * a person may act is checked to wait there, and ended.
 *
 * It appends to the development ledger, so it holds `LEDGER_LOCK`. Runs where the database and the sidecar are
 * configured and the development provider is on, which signs its contributor in; the store is a directory, and nothing
 * here signs a URL.
 */

const ready = env.DATABASE_URL !== undefined && env.OPA_URL !== undefined && env.AUTH_DEV_PROVIDER === "1";

const EMAIL = "worked-examples@harness-bible.local";
const ADDRESS = `2001:db8:50::${Date.now().toString(16)}`;
const SERVICE: ServiceCaller = { kind: "service", id: "service:grader" };

describe.skipIf(!ready)("the four worked examples, end to end (33 § 8, § 11.1, § 11.2)", () => {
  const environment = workflowEnvironment();
  let release: () => void = () => undefined;
  let stub: StubGateway | null = null;
  let contributor: ExampleContributor | null = null;

  beforeAll(async () => {
    release = await acquire(LEDGER_LOCK);
    await clearExampleAccount(EMAIL);
    stub = await startStubGateway();
    contributor = await signInContributor(EMAIL, ADDRESS);
  }, 300_000);

  afterAll(async () => {
    try {
      await stub?.close();
      await clearExampleAccount(EMAIL);
    } finally {
      release();
    }
  });

  /** The example drafted and run by the real workflow: its result where the run ends, what it waits for, or where its merge waits (54b). */
  async function run(example: WorkedExample) {
    if (stub === null || contributor === null) throw new Error("the suite did not start");
    const id: SuggestionId = await draftExample(example, contributor, ADDRESS);
    const activities = exampleActivities(stub, WORKED_EXAMPLES);
    const outcome = await environment().withWorker(activities, async (taskQueue): Promise<{ readonly result: SuggestionWorkflowResult | null; readonly waits: SuggestionWaits; readonly merge: MergeStage | null }> => {
      const handle = await environment().client.workflow.start(SUGGESTION_WORKFLOW, { taskQueue, workflowId: suggestionWorkflowId(id), args: [{ suggestionId: id }] });
      if (example.ends.merge !== null) {
        const merge = await mergeWaitingOf(environment().client.workflow.getHandle(mergeWorkflowId(id)));
        await handle.terminate("the worked example ends where its merge waits");
        return { result: null, waits: null, merge };
      }
      if (example.ends.waits === null) return { result: SuggestionWorkflowResultSchema.parse(await handle.result()), waits: null, merge: null };
      const waits = await waitingOf(handle);
      await handle.terminate("the worked example ends where it waits");
      return { result: null, waits, merge: null };
    });
    const row = await readSuggestionAsService(SERVICE, id);
    if (row === null) throw new Error(`${id} is gone`);
    return { id, row, records: await view({ suggestionId: id }), calls: stub.rows.filter((call) => call.ref === id).map((call) => [call.kind, call.alias]), ...outcome };
  }

  /** Where § 8 says it ends: the state, the score, the decision and who made it, the records in order, the chain verified (§ 11.1). */
  async function expectEnd(example: WorkedExample, ran: Awaited<ReturnType<typeof run>>): Promise<void> {
    const { ends } = example;
    expect(ran.row, example.name).toMatchObject({ state: ends.state, score: ends.score, outcome: ends.decision });
    expect(ran.row.adjudication, example.name).toMatchObject({ decision: ends.decision, decidedBy: ends.decidedBy, score: ends.score, sufficientTier: ends.sufficientTier });
    expect(ran.waits, example.name).toEqual(ends.waits);
    expect(ran.merge, example.name).toEqual(ends.merge);
    if (ran.result !== null) expect(ran.result, example.name).toMatchObject({ state: ends.state, route: ends.route, score: ends.score, decision: ends.decision, sufficientTier: ends.sufficientTier });
    expect(ran.records.map((record) => record.kind), example.name).toEqual(ends.records);
    const first = ran.records[0]?.seq ?? 0;
    const last = ran.records.at(-1)?.seq ?? 0;
    const { before } = await neighbours(first, last);
    const check = verifyChain((await range(first, last)).map(toChainRecord), before === null ? {} : { prevOfFirst: before.hash });
    expect(check, example.name).toMatchObject({ ok: true, from: first, to: last });
  }

  const example = (n: number): WorkedExample => {
    const found = WORKED_EXAMPLES[n - 1];
    if (found === undefined) throw new Error(`no example ${String(n)}`);
    return found;
  };

  it("1 · a cited date: one item, tier B, direct, nine days old, independent — 85, accepted by the adjudicator, then merging, its merge waiting for the book's repository (54b)", { timeout: 120_000 }, async () => {
    const ran = await run(example(1));
    await expectEnd(example(1), ran);
    expect(ran.row.evidence.map((item) => [item.tier, item.adjustedScore])).toEqual([["B", 85]]);
    /* the grade on the small model, then the one frontier call */
    expect(ran.calls).toEqual([
      ["GRADING", "hb-small"],
      ["ADJUDICATION", "hb-frontier"],
    ]);
  });

  it("2 · a cited figure on a screenshot: one upload, tier G — 5, declined at intake with no frontier call (§ 11.2), and what would suffice names B and D", { timeout: 120_000 }, async () => {
    const ran = await run(example(2));
    await expectEnd(example(2), ran);
    expect(ran.row.evidence.map((item) => [item.kind, item.tier, item.adjustedScore])).toEqual([["UPLOAD", "G", 5]]);
    /* invariant 11: its one call is the grader's, on the small model; none on the frontier */
    expect(ran.calls).toEqual([["GRADING", "hb-small"]]);
    const anchor = await resolveAnchor("FIGURE", "F-23-19", "en");
    const named = wouldSuffice(loadRubric(ran.row.rubricVersionId).rubric, gradedItemsOf(ran.row.evidence).items, ran.row.changeClass, anchor?.fastMoving ?? false).map((sufficient) => sufficient.tier);
    expect(named).toEqual(example(2).ends.wouldSuffice);
  });

  it("3 · a derived decision aid: a tier A run, partial relevance — 60, asked for more by rule, naming a tier A run, in the queue", { timeout: 120_000 }, async () => {
    const ran = await run(example(3));
    await expectEnd(example(3), ran);
    expect(ran.row.changeClass).toBe("DERIVED_FIGURE");
    /* graded as the IDE would leave it: nobody asked, no model called */
    expect(ran.calls).toEqual([]);
  });

  it("4 · a cited price: tier C from the vendor concerned (56) and tier D five months old (42) — 66, asked for more with tier D, in the queue for inspection", { timeout: 120_000 }, async () => {
    const ran = await run(example(4));
    await expectEnd(example(4), ran);
    expect(ran.row.evidence.map((item) => [item.tier, item.adjustedScore])).toEqual([
      ["C", 56],
      ["D", 42],
    ]);
    expect(ran.calls).toEqual([
      ["GRADING", "hb-small"],
      ["GRADING", "hb-small"],
      ["ADJUDICATION", "hb-frontier"],
    ]);
    expect(ran.records.at(-1)?.payload).toMatchObject({ decision: "REQUEST_MORE", decidedBy: "adjudicator", sufficientTier: "D", score: 66, acceptAt: 70, floorAt: 25 });
  });
});
