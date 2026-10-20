import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { aliasesFromConfig, startStub } from "@/infra/gateway/stub/server";
import { contributorForGrading, contributorStandingOf } from "@/lib/db/account";
import { releaseReadings, type ResolvedAnchor } from "@/lib/db/anchors";
import type { BudgetRowInput, Usage } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { addEvidenceItem, createDraft, moveAlong, readRubricVersion, readSuggestionAsService, requestWithdrawal, setRosterEntry, takeBackWithdrawal, updateDraft, writeEvidenceFetched, writeEvidenceGraded, writeEvidenceTextKey, type DraftInput, type ServiceCaller, type UserCaller } from "@/lib/db/improve";
import { view } from "@/lib/db/ledger";
import { env } from "@/lib/env";
import type { GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { encryptKey } from "@/lib/gateway/keys";
import { loadGuide } from "@/lib/guides/load";
import { authorize } from "@/lib/policy/opa";
import { detailSha256Of } from "@/lib/improve/decision";
import { countWords } from "@/lib/improve/words";
import { canonicalize } from "@/lib/ledger/canonical";
import { sha256Hex } from "@/lib/ledger/hash";
import { gradedItemsOf } from "@/lib/improve/scoring";
import { scoreOf } from "@/lib/rubric/score";
import { routeOf } from "@/lib/rubric/thresholds";
import { loadRubric } from "@/lib/rubrics/load";
import type { Principal } from "@/lib/schemas/gateway";
import { SuggestionIdSchema, type SuggestionId } from "@/lib/schemas/ids";
import { evidenceTextKey } from "@/lib/schemas/storage";
import { objectStore } from "@/lib/storage";
import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import { appendOnce, stepKeyOf } from "@/workers/activities/ledger";
import { suggestionActivities, type SuggestionActivityDeps } from "@/workers/activities/suggestion";
import { adjudicate } from "@/workers/agents/adjudicator/adjudicate";
import type { SensorOutcome } from "@/workers/workflows/activities";

/*
 * SuggestionWorkflow's activities against the database, the ledger and the store (feature-specs/33 § 3; unit 50a),
 * with the anchor's resolution and the grading calls' tokens doubled: step 1 moves a consenting contributor's draft out
 * and signs the `submitted` record with their pseudonym, once, and leaves an unconsenting one's a draft (invariant
 * 25); step 2 writes the four sensors' verdicts, and an anchor the release no longer has fails (§ 11.3); step 3
 * scores the rows as the view does and appends the `graded` record once (§ 11.9), each item with the hashes of its
 * reason and of what the grader read, and writes the score after it; step 4 routes by the suggestion's own rubric.
 * Step 7 (unit 50d) asks the policy sidecar, checks what was recorded, and calls the stub gateway, started in this
 * process with its ledger rows kept here: no model is asked and the gateway's ledger is not written. Steps 8 and 9
 * (unit 50e) record each kind of decision — by rule, by the router, by the adjudicator and for its failure — with its
 * rows, its two records and its moves; and, while a suggestion waits, a curator's decision with its `curator` record and
 * calibration event, a revision's return with its own `submitted` record, and since unit 63e a contributor's withdrawal
 * with its `retracted` record (feature-specs/45 § 5.3).
 *
 * The rows are a chapter no book has, 95, whose serials this suite never resets, so a suggestion's id — and the
 * records the ledger keeps of it for good — are each run's own. It appends to the development ledger, so it holds
 * `LEDGER_LOCK` while it runs (tests/fixtures/exclusive.ts). Runs where DATABASE_URL and OBJECT_STORE_SECRET are set.
 */

const ready = env.DATABASE_URL !== undefined && env.OBJECT_STORE_SECRET !== undefined;

const CHAPTER = 95;
const CHAPTER_VERSION = "00000000-0000-4000-8000-0000000050a0";
const CONSENTING = "00000000-0000-4000-8000-0000000050a1";
const UNCONSENTING = "00000000-0000-4000-8000-0000000050a2";
const UNVERIFIED = "00000000-0000-4000-8000-0000000050a3";
/** A curator of part 2, whose roster entry began before any action of this suite. */
const CURATOR = "00000000-0000-4000-8000-0000000050a4";
/** A contributor of the throttle's case alone, so that no other case's declines count toward it. */
const THROTTLED = "00000000-0000-4000-8000-0000000050a5";
const throttled: UserCaller = { kind: "user", userId: THROTTLED, role: "CONTRIBUTOR", parts: [] };
const consenting: UserCaller = { kind: "user", userId: CONSENTING, role: "CONTRIBUTOR", parts: [] };
const unconsenting: UserCaller = { ...consenting, userId: UNCONSENTING };
const unverified: UserCaller = { ...consenting, userId: UNVERIFIED };
const GRADER: ServiceCaller = { kind: "service", id: "service:grader" };

const SECTION_TEXT = "Retries are not optional at eleven steps, whatever the budget says.";
const SHA = sha256Hex(SECTION_TEXT);
const PROPOSAL = { kind: "EDIT_TEXT", before: "not optional", after: "required" } as const;
const RATIONALE = "The section's own lab shows every step retried.";
const PASSES: ReadonlyArray<SensorOutcome> = (["SCHEMA", "ANCHOR_EXISTS", "EVIDENCE_PARSES", "RATIONALE_LENGTH"] as const).map((sensor) => ({ sensor, result: "PASS" }));
const USAGE: Usage = { inputTokens: 3500, outputTokens: 14, cacheReadTokens: 6 };
const ADJUDICATION_USAGE: Usage = { inputTokens: 1218, outputTokens: 552, cacheReadTokens: 0 };
const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
/** The section as the release has it now: the text the draft recorded, so its anchor still exists. */
const RESOLVED = { kind: "SECTION", sectionAnchor: "95.3", figureAnchor: null, sourceRowAnchor: null, currentText: SECTION_TEXT, contentSha256: SHA, figures: [], chapterVersionId: CHAPTER_VERSION, chapterVersion: "1.0.0", fastMoving: false } as unknown as ResolvedAnchor;

const draft = (over: Partial<DraftInput> = {}): DraftInput => ({
  chapterNumber: CHAPTER,
  chapterVersionId: CHAPTER_VERSION,
  releaseId: "2026.09",
  parts: ["P2"],
  changeKind: "EDIT_TEXT",
  changeClass: "WORDING",
  curatorReason: null,
  locale: "EN",
  rubricVersionId: "v1.2",
  anchor: { kind: "SECTION", sectionAnchor: "95.3", figureAnchor: null, sourceRowAnchor: null, currentText: SECTION_TEXT, contentSha256: SHA, existsAtVersion: true },
  ...over,
});

const written: string[] = [];
const usageAsked: Array<{ readonly principal: Principal; readonly suggestionId: string; readonly since: Date | null }> = [];
const adjudicationAsked: Array<{ readonly principal: Principal; readonly suggestionId: string; readonly since: Date | null }> = [];

/* The stub gateway, for step 7: what it was sent and the ledger rows the client would have appended. */
let stub: Awaited<ReturnType<typeof startStub>> | null = null;
let stubKey = "";
const keySecret = randomBytes(32).toString("hex");
const gatewayRows: BudgetRowInput[] = [];
const sent: string[] = [];
function stubGateway(headers: Record<string, string> = {}): GatewayDeps {
  return {
    baseUrl: stub?.url ?? "",
    keySecret,
    findKey: async () => ({ keyCiphertext: encryptKey(keySecret, stubKey) }),
    append: async (row) => {
      gatewayRows.push(row);
    },
    log: () => undefined,
    fetch: async (input, init) => {
      const merged = new Headers(init?.headers);
      for (const [name, value] of Object.entries(headers)) merged.set(name, value);
      sent.push(typeof init?.body === "string" ? init.body : "");
      return globalThis.fetch(input, { ...init, headers: merged });
    },
    now: () => new Date("2026-10-07T12:00:00Z"),
  };
}

function depsOf(over: Partial<SuggestionActivityDeps> = {}): SuggestionActivityDeps {
  return {
    store: objectStore,
    anchor: async () => RESOLVED,
    chapterVersion: async () => ({ id: CHAPTER_VERSION, version: "1.0.0" }),
    rubricVersion: readRubricVersion,
    researchPrincipal: () => null,
    endorsement: async () => null,
    loadRubric,
    contributor: contributorForGrading,
    gradingUsage: async (principal, suggestionId, since) => {
      usageAsked.push({ principal, suggestionId, since });
      return USAGE;
    },
    adjudicationUsage: async (principal, suggestionId, since) => {
      adjudicationAsked.push({ principal, suggestionId, since });
      return ADJUDICATION_USAGE;
    },
    readings: releaseReadings,
    /* chapter 95 is not in the book: no files to apply a change to */
    book: () => null,
    authorize,
    adjudicatorGuide: () => loadGuide("adjudicator", "v2.1"),
    adjudicate: (input) => adjudicate(input, { gateway: stubGateway() }),
    now: () => new Date("2026-10-07T12:00:00.000Z"),
    ...over,
  };
}

/** A draft with its proposal and rationale written, as its owner's PATCH leaves it. */
async function writtenDraft(caller: UserCaller, over: Partial<DraftInput> = {}): Promise<SuggestionId> {
  const made = await createDraft(caller, draft(over));
  const id = SuggestionIdSchema.parse(made.id);
  written.push(id);
  await updateDraft(caller, id, { proposal: { proposal: PROPOSAL, proposalKey: sha256Hex(`the key of ${id}`), changeClass: "WORDING", curatorReason: null }, rationale: RATIONALE });
  return id;
}

interface ItemGrade {
  readonly fetchStatus: string;
  readonly tier: "C" | "G" | "U";
  readonly baseScore: number;
  readonly factors: readonly [number, number, number] | null;
  readonly adjustedScore: number;
  readonly reason: string;
  readonly gradedBy: string;
  /** What the grader read, stored under the item's `text` key; none for an item that could not be opened. */
  readonly text: string | null;
}

const VENDOR: ItemGrade = { fetchStatus: "opened:200", tier: "C", baseScore: 70, factors: [1, 1, 0.8], adjustedScore: 56, reason: "the vendor's own pricing page states the figure", gradedBy: "suite-model", text: "Team plan: retries are billed as requests." };
const REFUSED: ItemGrade = { fetchStatus: "unreachable:403", tier: "U", baseScore: 0, factors: null, adjustedScore: 0, reason: "403", gradedBy: "intake-rules", text: null };
/** A screenshot with no source: graded, but on tier G, which the throttle does not count. */
const SCREENSHOT: ItemGrade = { fetchStatus: "opened:200", tier: "G", baseScore: 5, factors: [1, 1, 1], adjustedScore: 5, reason: "a screenshot with no source shows the figure", gradedBy: "suite-model", text: "A screenshot of a dashboard." };
/** A vendor's page that bears on the change in part: 33 against a wording change's acceptance of 40, so the stub asks for more. */
const PARTIAL: ItemGrade = { fetchStatus: "opened:200", tier: "C", baseScore: 70, factors: [0.6, 1, 0.8], adjustedScore: 33, reason: "the vendor's page bears on the change only in part", gradedBy: "suite-model", text: "Retries are billed per step." };

/** An item added by the owner and taken through the grader's writes, as GradeEvidenceWorkflow leaves it; pending when `grade` is null. */
async function item(caller: UserCaller, suggestionId: string, grade: ItemGrade | null, host = "pages.example"): Promise<string> {
  const id = randomUUID();
  await addEvidenceItem(caller, suggestionId, { id, kind: "LINK", url: `https://pages.example/${id}`, doi: null, storageKey: null, host }, 10);
  if (grade === null) return id;
  await writeEvidenceFetched(GRADER, id, { fetchStatus: grade.fetchStatus, host, title: null, publishedOn: null, contentSha256: null });
  if (grade.text !== null) {
    const key = evidenceTextKey(suggestionId, id);
    await objectStore().put(key, Buffer.from(grade.text, "utf8"), "text/plain; charset=utf-8");
    await writeEvidenceTextKey(GRADER, id, key);
  }
  const [relevance, recency, independence] = grade.factors ?? [null, null, null];
  await writeEvidenceGraded(GRADER, id, { tier: grade.tier, baseScore: grade.baseScore, relevance, recency, independence, adjustedScore: grade.adjustedScore, reason: grade.reason, gradedBy: grade.gradedBy, gradedAt: new Date("2026-10-06T12:00:00.000Z"), publishedOn: null, ageDays: null });
  return id;
}

/** A consenting contributor's suggestion with a vendor's page and a refused link, through step 1. */
async function submitted(): Promise<{ readonly id: SuggestionId; readonly workflowId: string; readonly vendor: string; readonly refused: string }> {
  const id = await writtenDraft(consenting);
  const vendor = await item(consenting, id, VENDOR);
  const refused = await item(consenting, id, REFUSED);
  const workflowId = `suggestion:${id}`;
  await suggestionActivities(depsOf()).recordSubmitted(id, workflowId);
  return { id, workflowId, vendor, refused };
}

async function clear(): Promise<void> {
  const prisma = getPrisma();
  /* The suite's suggestions back to draft so that they can go, a move nothing of the product makes; the counter stays. */
  await prisma.$executeRawUnsafe(`UPDATE "Suggestion" SET "state" = 'DRAFT' WHERE "chapterNumber" = ${String(CHAPTER)}`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Suggestion" WHERE "chapterNumber" = ${String(CHAPTER)}`);
  /* The suite's rubric review, in its own far quarter (36 § 6.3): nothing real is ever there. */
  await prisma.$executeRawUnsafe(`DELETE FROM "RubricReview" WHERE "quarter" = '2099-Q1'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "CuratorRoster" WHERE "userId" = '${CURATOR}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" IN ('${CONSENTING}', '${UNCONSENTING}', '${UNVERIFIED}', '${CURATOR}', '${THROTTLED}')`);
}

describe.skipIf(!ready)("SuggestionWorkflow's activities, against the database, the ledger and the store", () => {
  let release: () => void = () => undefined;

  beforeAll(async () => {
    release = await acquire(LEDGER_LOCK);
    const masterKey = randomBytes(24).toString("hex");
    const aliases = aliasesFromConfig(readFileSync(join(process.cwd(), "infra", "gateway", "litellm.yaml"), "utf8"));
    stub = await startStub({ masterKey, aliases, port: 0, log: () => undefined });
    const minted = await fetch(`${stub.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" }, body: JSON.stringify({ models: [...aliases.keys()], max_budget: 1_000 }) });
    stubKey = ((await minted.json()) as { key: string }).key;
    await clear();
    await getPrisma().$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "displayName", "role", "identityVerified", "provenanceConsentAt") VALUES ('${CONSENTING}', 'suggestion-workflow-a@harness-bible.local', 'Consenting contributor of the workflow suite', 'CONTRIBUTOR', true, '2026-10-06T12:00:00Z'), ('${UNCONSENTING}', 'suggestion-workflow-b@harness-bible.local', 'Unconsenting contributor of the workflow suite', 'CONTRIBUTOR', true, NULL), ('${UNVERIFIED}', 'suggestion-workflow-c@harness-bible.local', 'Unverified contributor of the workflow suite', 'CONTRIBUTOR', false, '2026-10-06T12:00:00Z'), ('${CURATOR}', 'suggestion-workflow-d@harness-bible.local', 'Curator of the workflow suite', 'CURATOR', true, NULL), ('${THROTTLED}', 'suggestion-workflow-e@harness-bible.local', 'Throttled contributor of the workflow suite', 'CONTRIBUTOR', true, '2026-10-06T12:00:00Z')`,
    );
    await setRosterEntry({ userId: CURATOR, part: "P2", until: null }, new Date("2026-10-01T00:00:00.000Z"));
  }, 300_000);

  afterAll(async () => {
    try {
      await stub?.close();
      await clear();
      for (const id of written) await rm(`${env.OBJECT_STORE_DIR}/evidence/${id}`, { recursive: true, force: true });
    } finally {
      release();
    }
  });

  it("step 1: moves a consenting contributor's draft out and appends its submitted record once, signed with their pseudonym", async () => {
    const id = await writtenDraft(consenting);
    const vendor = await item(consenting, id, VENDOR);
    /* A host the record's form refuses, as a redirect to an address can leave one: recorded null, the row keeping it. */
    const bracketed = await item(consenting, id, REFUSED, "[2606:4700::1111]");
    const workflowId = `suggestion:${id}`;
    const activities = suggestionActivities(depsOf());
    expect(await activities.recordSubmitted(id, workflowId)).toEqual({ state: "SUBMITTED" });
    /* Run again, as the engine may: the row is past draft and the record is there. */
    expect(await activities.recordSubmitted(id, workflowId)).toEqual({ state: "SUBMITTED" });

    expect(await readSuggestionAsService(GRADER, id)).toMatchObject({ state: "SUBMITTED", workflowId, submittedAt: new Date("2026-10-07T12:00:00.000Z") });
    const records = await view({ suggestionId: id });
    expect(records.map((record) => record.kind)).toEqual(["SUBMITTED"]);
    expect(records[0]).toMatchObject({ actor: `user:${CONSENTING}`, suggestionId: id, chapterVersionId: CHAPTER_VERSION });
    expect(records[0]?.payload).toEqual({
      stepKey: sha256Hex(`${workflowId}:submitted:1`),
      rubricVersion: "v1.2",
      origin: "HUMAN",
      releaseId: "2026.09",
      changeKind: "EDIT_TEXT",
      changeClass: "WORDING",
      curatorReason: null,
      anchor: { kind: "SECTION", section: "95.3", figure: null, sourceRow: null, chapterVersionId: CHAPTER_VERSION, contentSha256: SHA, existsAtVersion: true },
      proposalSha256: sha256Hex(canonicalize(PROPOSAL)),
      proposalKey: sha256Hex(`the key of ${id}`),
      rationaleSha256: sha256Hex(RATIONALE),
      rationaleWords: countWords(RATIONALE),
      evidence: [
        { id: vendor, kind: "LINK", host: "pages.example", doi: null },
        { id: bracketed, kind: "LINK", host: null, doi: null },
      ],
      verified: true,
    });
  });

  it("step 1: leaves an unconsenting contributor's draft a draft and asks to be tried again, recording nothing (invariant 25); a suggestion that is not there is not tried again", async () => {
    const id = await writtenDraft(unconsenting);
    const activities = suggestionActivities(depsOf());
    expect(await activities.recordSubmitted(id, `suggestion:${id}`).catch((error: unknown) => error)).toMatchObject({ type: "STILL_A_DRAFT", nonRetryable: false });
    expect(await readSuggestionAsService(GRADER, id)).toMatchObject({ state: "DRAFT", workflowId: null });
    expect(await view({ suggestionId: id })).toEqual([]);
    /* Consent on file is not enough: a contributor no longer verified — every sign-in rewrites it — is held back the same way. */
    const unverifiedDraft = await writtenDraft(unverified);
    expect(await activities.recordSubmitted(unverifiedDraft, `suggestion:${unverifiedDraft}`).catch((error: unknown) => error)).toMatchObject({ type: "STILL_A_DRAFT", nonRetryable: false });
    expect(await readSuggestionAsService(GRADER, unverifiedDraft)).toMatchObject({ state: "DRAFT" });
    expect(await activities.recordSubmitted(SuggestionIdSchema.parse("S-95-99999999"), "suggestion:S-95-99999999").catch((error: unknown) => error)).toMatchObject({ type: "SUGGESTION_MISSING", nonRetryable: true });
  });

  it("step 2: runs the four sensors on the rows and writes their verdicts; an anchor the release no longer has fails ANCHOR_EXISTS (§ 11.3)", async () => {
    const { id } = await submitted();
    expect(await suggestionActivities(depsOf()).runIntake(id)).toEqual(PASSES);
    let rows = (await readSuggestionAsService(GRADER, id))?.sensorVerdicts ?? [];
    expect(rows.map((row) => [row.sensor, row.result])).toEqual(PASSES.map((verdict) => [verdict.sensor, verdict.result]));

    expect(await suggestionActivities(depsOf({ anchor: async () => null })).runIntake(id)).toEqual(PASSES.map((verdict) => (verdict.sensor === "ANCHOR_EXISTS" ? { ...verdict, result: "FAIL" } : verdict)));
    rows = (await readSuggestionAsService(GRADER, id))?.sensorVerdicts ?? [];
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.sensor === "ANCHOR_EXISTS")).toMatchObject({ result: "FAIL", detail: "95.3 does not exist at ch95 v1.0.0" });

    /* The anchor is resolved by its own kind and id in the suggestion's locale: a figure, in Portuguese. */
    const asked: unknown[] = [];
    const figure = await writtenDraft(consenting, { locale: "PT", anchor: { kind: "FIGURE", sectionAnchor: "95.3", figureAnchor: "F-95-01", sourceRowAnchor: null, currentText: "Team · 20 rps", contentSha256: SHA, existsAtVersion: true } });
    await item(consenting, figure, VENDOR);
    await suggestionActivities(depsOf()).recordSubmitted(figure, `suggestion:${figure}`);
    await suggestionActivities(depsOf({ anchor: async (kind, anchorId, locale) => (asked.push([kind, anchorId, locale]), RESOLVED) })).runIntake(figure);
    expect(asked).toEqual([["FIGURE", "F-95-01", "pt"]]);

    /* An item still pending passes step 2 by its form and is left to step 3, which names it (option A, Andre). */
    const withPending = await writtenDraft(consenting);
    await item(consenting, withPending, VENDOR);
    const pending = await item(consenting, withPending, null);
    await suggestionActivities(depsOf()).recordSubmitted(withPending, `suggestion:${withPending}`);
    expect(await suggestionActivities(depsOf()).runIntake(withPending)).toEqual(PASSES);
    expect(((await readSuggestionAsService(GRADER, withPending))?.sensorVerdicts ?? []).find((row) => row.sensor === "EVIDENCE_PARSES")).toMatchObject({ result: "PASS", detail: "2 items, each with what its kind needs" });
    expect(await suggestionActivities(depsOf()).pendingItems(withPending)).toEqual([pending]);

    /* A draft has no step 2. */
    const aDraft = await writtenDraft(consenting);
    expect(await suggestionActivities(depsOf()).runIntake(aDraft).catch((error: unknown) => error)).toMatchObject({ type: "NOT_SUBMITTED", nonRetryable: true });
  });

  it("names the items still pending, in the order they were added", async () => {
    const id = await writtenDraft(consenting);
    await item(consenting, id, VENDOR);
    const first = await item(consenting, id, null);
    const second = await item(consenting, id, null);
    expect(await suggestionActivities(depsOf()).pendingItems(id)).toEqual([first, second]);
  });

  it("step 3: scores the rows as the view does, appends the graded record once with what each item was graded on, and writes the score after it (§ 3.3, § 11.9)", async () => {
    const { id, workflowId, vendor, refused } = await submitted();
    usageAsked.length = 0;
    const activities = suggestionActivities(depsOf());
    const first = await activities.recordGraded(id, workflowId, 1, "ab".repeat(16));
    /* The workers killed between steps 3 and 4 and the step run again: one record, the same answer. */
    const again = await activities.recordGraded(id, workflowId, 1, "cd".repeat(16));

    const row = await readSuggestionAsService(GRADER, id);
    const expected = scoreOf(loadRubric("v1.2").rubric, gradedItemsOf(row?.evidence ?? []).items);
    expect(first).toEqual({ score: expected.score, strongestTier: "C" });
    expect(again).toEqual(first);
    expect(row).toMatchObject({ state: "SUBMITTED", score: expected.score });

    const graded = (await view({ suggestionId: id })).filter((record) => record.kind === "GRADED");
    expect(graded).toHaveLength(1);
    expect(graded[0]).toMatchObject({ actor: "service:grader", chapterVersionId: CHAPTER_VERSION });
    const text = await objectStore().head(evidenceTextKey(id, vendor));
    const at = (itemId: string) => expected.perItem.find((entry) => entry.id === itemId);
    expect(graded[0]?.payload).toEqual({
      stepKey: sha256Hex(`${workflowId}:graded:1`),
      rubricVersion: "v1.2",
      origin: "HUMAN",
      items: [
        { id: vendor, kind: "LINK", fetchStatus: "opened:200", tier: "C", base: at(vendor)?.base, relevance: 1, recency: 1, independence: 0.8, adjusted: at(vendor)?.adjusted, gradedBy: "suite-model", reasonSha256: sha256Hex(VENDOR.reason), contentSha256: text?.sha256 },
        { id: refused, kind: "LINK", fetchStatus: "unreachable:403", tier: "U", base: 0, relevance: null, recency: null, independence: null, adjusted: 0, gradedBy: "intake-rules", reasonSha256: sha256Hex("403"), contentSha256: null },
      ],
      score: expected.score,
      strongestItemId: vendor,
      corroboratedById: null,
      usage: USAGE,
      traceId: "ab".repeat(16),
    });
    expect(text?.sha256).toBe(sha256Hex(VENDOR.text ?? ""));
    /* The tokens asked for: the contributor's principal, this suggestion, since no earlier graded record. */
    expect(usageAsked[0]).toEqual({ principal: { userId: CONSENTING }, suggestionId: id, since: null });

    /* A second attempt (33 § 6.4) writes a record of its own, counting the calls since the first one's. */
    await activities.recordGraded(id, workflowId, 2, "ef".repeat(16));
    const both = (await view({ suggestionId: id })).filter((record) => record.kind === "GRADED");
    expect(both.map((record) => (record.payload as { readonly stepKey: string }).stepKey)).toEqual([sha256Hex(`${workflowId}:graded:1`), sha256Hex(`${workflowId}:graded:2`)]);
    expect(usageAsked.at(-1)).toEqual({ principal: { userId: CONSENTING }, suggestionId: id, since: both[0]?.createdAt });
  });

  it("step 3: refuses to score while an item is pending, and a rubric file that is not the one published", async () => {
    const id = await writtenDraft(consenting);
    await item(consenting, id, VENDOR);
    await item(consenting, id, null);
    await suggestionActivities(depsOf()).recordSubmitted(id, `suggestion:${id}`);
    expect(await suggestionActivities(depsOf()).recordGraded(id, `suggestion:${id}`, 1, "ab".repeat(16)).catch((error: unknown) => error)).toMatchObject({ type: "ITEM_PENDING", nonRetryable: true });

    const { id: other, workflowId } = await submitted();
    const tampered = depsOf({ loadRubric: (version) => ({ ...loadRubric(version), sha256: "f".repeat(64) }) });
    expect(await suggestionActivities(tampered).recordGraded(other, workflowId, 1, "ab".repeat(16)).catch((error: unknown) => error)).toMatchObject({ type: "NO_RUBRIC", nonRetryable: true });
    expect((await view({ suggestionId: other })).map((record) => record.kind)).toEqual(["SUBMITTED"]);
  });

  it("step 5: writes the three consistency verdicts as rows, and widens the parts to those another reading of the anchor reaches (§ 11.5)", async () => {
    const { id } = await submitted();
    /* nothing in the release reads 95.3, and there are no files to apply the change to */
    expect(await suggestionActivities(depsOf()).runConsistency(id)).toEqual([{ sensor: "DERIVE_CONSISTENCY", result: "NA" }, { sensor: "CROSS_CHAPTER", result: "PASS" }, { sensor: "LINT", result: "NA" }]);
    const rows = (await readSuggestionAsService(GRADER, id))?.sensorVerdicts ?? [];
    expect(rows.find((row) => row.sensor === "LINT")).toMatchObject({ result: "NA", detail: "the files read are not the release's, so the change could not be applied" });
    /* a suggestion only through step 1 here: the three of step 5 and no other */
    expect(rows.map((row) => row.sensor).sort()).toEqual(["CROSS_CHAPTER", "DERIVE_CONSISTENCY", "LINT"]);
    /* a section of part 3 that refers to it: a warning, and part 3's curators see the suggestion */
    const shared = suggestionActivities(depsOf({ readings: async () => ({ figures: [], references: [{ from: "37.4", part: "P3", target: "95.3" }], gitSha: "none" }) }));
    expect((await shared.runConsistency(id))[1]).toEqual({ sensor: "CROSS_CHAPTER", result: "WARN" });
    expect((await readSuggestionAsService(GRADER, id))?.parts).toEqual(["P2", "P3"]);
    /* run again, the part is there once */
    await shared.runConsistency(id);
    expect((await readSuggestionAsService(GRADER, id))?.parts).toEqual(["P2", "P3"]);
  });

  /** A suggestion through steps 1 to 5 as the workflow leaves it for step 7: its seven verdicts, its graded record, its score. */
  async function sensedAndGraded(): Promise<{ readonly id: SuggestionId; readonly workflowId: string; readonly trace: string }> {
    const { id, workflowId } = await submitted();
    const activities = suggestionActivities(depsOf());
    await activities.runIntake(id);
    const trace = randomBytes(16).toString("hex");
    await activities.recordGraded(id, workflowId, 1, trace);
    await activities.runConsistency(id);
    return { id, workflowId, trace };
  }

  it("step 7: asks the policy, checks what was recorded, adjudicates once and writes the decision with its six criteria, the call charged to the contributor (§ 5, § 7, § 11.6)", async () => {
    const { id, workflowId, trace } = await sensedAndGraded();
    gatewayRows.length = 0;
    sent.length = 0;
    /* a wording change at 56 against an acceptance of 40: the stub accepts, as the arithmetic allows */
    expect(await suggestionActivities(depsOf()).adjudicateSuggestion(id, workflowId, 1, trace)).toEqual({ outcome: "DECIDED", decision: "ACCEPT", sufficientTier: null });

    const row = await readSuggestionAsService(GRADER, id);
    const guide = loadGuide("adjudicator", "v2.1");
    expect(row?.adjudication).toMatchObject({ decision: "ACCEPT", decidedBy: "adjudicator", score: 56, acceptAt: 40, floorAt: 5, sufficientTier: null, failingSensor: null, guideVersion: "v2.1", guideSha256: guide.sha256, failure: null, rubricVersionId: "v1.2", traceId: trace });
    expect(row?.adjudication?.modelId).toEqual(expect.any(String));
    expect(row?.adjudication?.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.criteria.map((line) => [line.criterion, line.verdict])).toEqual([["corroboration", "graded"], ["independence", "graded"], ["recency", "graded"], ["relevance", "graded"], ["threshold", "56>=40"], ["tier", "graded"]]);
    /* one call, charged to the contributor's principal as an adjudication of this suggestion */
    expect(gatewayRows).toHaveLength(1);
    expect(gatewayRows[0]).toMatchObject({ principal: { userId: CONSENTING }, kind: "ADJUDICATION", ref: id, traceId: trace });
    /* The prompt holds the seven verdicts and the rationale, and nothing that names the contributor or the origin (invariant 12, § 11.6). The
       principal is in the request's metadata only, the gateway's spend attribution, which the model does not read. */
    const request = JSON.parse(sent[0] ?? "{}") as { readonly system: unknown; readonly messages: unknown; readonly metadata: { readonly user_id: string } };
    const prompt = JSON.stringify({ system: request.system, messages: request.messages });
    expect(prompt).toContain("CROSS_CHAPTER PASS");
    expect(prompt).toContain(RATIONALE);
    for (const named of [CONSENTING, "suggestion-workflow-a@harness-bible.local", "Consenting contributor", "HUMAN", "origin"]) expect(prompt, named).not.toContain(named);
    for (const named of ["suggestion-workflow-a@harness-bible.local", "Consenting contributor", "HUMAN"]) expect(sent[0], named).not.toContain(named);
    expect(request.metadata.user_id).toBe(`user:${CONSENTING}`);
  });

  it("step 7: a claim declared fast-moving on a stable section reaches the adjudicator's anchor as fast-moving, whatever the section's flag (30 § 3.4, as decided)", async () => {
    const made = await createDraft(consenting, draft({ changeKind: "ADD_CLAIM", changeClass: "NEW_CLAIM" }));
    const id = SuggestionIdSchema.parse(made.id);
    written.push(id);
    const claim = { kind: "ADD_CLAIM", text: "Provider tier 3 cut its retry price in September 2026.", placeAfter: "end", fastMoving: true } as const;
    await updateDraft(consenting, id, { proposal: { proposal: claim, proposalKey: sha256Hex(`the key of ${id}`), changeClass: "NEW_CLAIM", curatorReason: null }, rationale: RATIONALE });
    await item(consenting, id, VENDOR);
    const workflowId = `suggestion:${id}`;
    const activities = suggestionActivities(depsOf());
    await activities.recordSubmitted(id, workflowId);
    await activities.runIntake(id);
    const trace = randomBytes(16).toString("hex");
    await activities.recordGraded(id, workflowId, 1, trace);
    await activities.runConsistency(id);
    sent.length = 0;
    await activities.adjudicateSuggestion(id, workflowId, 1, trace);
    const request = JSON.parse(sent[0] ?? "{}") as { readonly messages: unknown };
    expect(JSON.stringify(request.messages)).toContain(String.raw`fast-moving=\"true\"`);
    expect(RESOLVED.fastMoving).toBe(false);
  });

  it("step 7: a text changed after its record was written, or an answer code refuses, is the adjudicator's failure, named on the row for the curator (§ 11.7, § 11.8)", async () => {
    const changed = await sensedAndGraded();
    await getPrisma().$executeRawUnsafe(`UPDATE "Suggestion" SET "rationale" = 'A rationale written after it was recorded.' WHERE "id" = '${changed.id}'`);
    sent.length = 0;
    expect(await suggestionActivities(depsOf()).adjudicateSuggestion(changed.id, changed.workflowId, 1, changed.trace)).toEqual({ outcome: "FAILED" });
    expect((await readSuggestionAsService(GRADER, changed.id))?.adjudication).toMatchObject({ decision: "CURATOR_REVIEW", decidedBy: "adjudicator", failure: "the rationale is not the one its submitted record holds", modelId: null, promptSha256: null });
    /* no call was made */
    expect(sent).toHaveLength(0);

    const refused = await sensedAndGraded();
    const fiveCriteria = depsOf({ adjudicate: (input) => adjudicate(input, { gateway: stubGateway({ "x-hb-stub-adjudicate": "missing-criterion" }) }) });
    expect(await suggestionActivities(fiveCriteria).adjudicateSuggestion(refused.id, refused.workflowId, 1, refused.trace)).toEqual({ outcome: "FAILED" });
    const row = await readSuggestionAsService(GRADER, refused.id);
    expect(row?.adjudication).toMatchObject({ decision: "CURATOR_REVIEW", failure: "criteria: no verdict on threshold" });
    expect(row?.adjudication?.modelId).toEqual(expect.any(String));
    expect(row?.criteria).toEqual([]);
  });

  it("step 7: the policy refuses the adjudicator a curator-always change, and nothing is called or written (§ 11.12); a budget refusal writes nothing for 50f's wait", async () => {
    const { id, workflowId, trace } = await sensedAndGraded();
    await getPrisma().$executeRawUnsafe(`UPDATE "Suggestion" SET "changeClass" = 'CURATOR_ALWAYS', "curatorReason" = 'SAFETY_OT' WHERE "id" = '${id}'`);
    sent.length = 0;
    expect(await suggestionActivities(depsOf()).adjudicateSuggestion(id, workflowId, 1, trace)).toEqual({ outcome: "REFUSED" });
    expect(sent).toHaveLength(0);
    expect((await readSuggestionAsService(GRADER, id))?.adjudication).toBeNull();

    const waiting = await sensedAndGraded();
    const capped = depsOf({
      adjudicate: async () => {
        throw new BudgetExceededError(new Date("2026-11-01T00:00:00Z"), "the principal's budget is spent");
      },
    });
    expect(await suggestionActivities(capped).adjudicateSuggestion(waiting.id, waiting.workflowId, 1, waiting.trace)).toEqual({ outcome: "BUDGET", resetsAt: "2026-11-01T00:00:00.000Z", waitMs: Date.parse("2026-11-01T00:00:00.000Z") - Date.parse("2026-10-07T12:00:00.000Z") });
    expect((await readSuggestionAsService(GRADER, waiting.id))?.adjudication).toBeNull();

    /* while the run sleeps, the suggestion says until when; when it wakes, it says nothing (33 § 7; unit 50f) */
    const activities = suggestionActivities(depsOf());
    await activities.markBudgetWait(waiting.id, "2026-11-01T00:00:00.000Z");
    expect((await readSuggestionAsService(GRADER, waiting.id))?.budgetResetsAt?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    await activities.markBudgetWait(waiting.id, null);
    expect((await readSuggestionAsService(GRADER, waiting.id))?.budgetResetsAt).toBeNull();
  });

  it("step 7's own failure is written by its code unless the attempt wrote its row first, whose decision is then what stands; a late attempt changes no failure written", async () => {
    const { id, workflowId, trace } = await sensedAndGraded();
    const activities = suggestionActivities(depsOf());
    await activities.adjudicateSuggestion(id, workflowId, 1, trace);
    expect(await activities.recordAdjudicatorFailure(id, trace, "TIMEOUT")).toEqual({ outcome: "DECIDED", decision: "ACCEPT", sufficientTier: null });
    expect((await readSuggestionAsService(GRADER, id))?.adjudication).toMatchObject({ decision: "ACCEPT", failure: null });

    const other = await sensedAndGraded();
    expect(await activities.recordAdjudicatorFailure(other.id, other.trace, "TIMEOUT")).toEqual({ outcome: "FAILED" });
    const row = await readSuggestionAsService(GRADER, other.id);
    expect(row?.adjudication).toMatchObject({ decision: "CURATOR_REVIEW", decidedBy: "adjudicator", score: 56, acceptAt: 40, floorAt: 5, failure: "the adjudication did not finish (TIMEOUT)", modelId: null, traceId: other.trace });
    expect(row?.criteria).toEqual([]);
    /* the attempt, still running after the engine gave up on it, finishes: its decision does not replace the failure */
    await activities.adjudicateSuggestion(other.id, other.workflowId, 1, other.trace);
    expect((await readSuggestionAsService(GRADER, other.id))?.adjudication).toMatchObject({ decision: "CURATOR_REVIEW", failure: "the adjudication did not finish (TIMEOUT)" });
    expect((await readSuggestionAsService(GRADER, other.id))?.criteria).toEqual([]);

    /* what failed may be the guide or the rubric itself: the failure is written without them */
    const broken = await sensedAndGraded();
    const unloadable = suggestionActivities(
      depsOf({
        adjudicatorGuide: () => {
          throw new Error("guides/adjudicator/v2.1 is not there");
        },
        loadRubric: (version) => ({ ...loadRubric(version), sha256: "f".repeat(64) }),
      }),
    );
    expect(await unloadable.recordAdjudicatorFailure(broken.id, broken.trace, "NO_RUBRIC")).toEqual({ outcome: "FAILED" });
    expect((await readSuggestionAsService(GRADER, broken.id))?.adjudication).toMatchObject({ decision: "CURATOR_REVIEW", failure: "the adjudication did not finish (NO_RUBRIC)", guideVersion: null, guideSha256: null, acceptAt: null, floorAt: null });
  });

  it("step 7: a policy that could not be asked refuses nothing: the adjudicator's failure, named, with no call", async () => {
    const { id, workflowId, trace } = await sensedAndGraded();
    sent.length = 0;
    const unreachable = depsOf({ authorize: async () => ({ allow: false, reason: "opa_unreachable" }) });
    expect(await suggestionActivities(unreachable).adjudicateSuggestion(id, workflowId, 1, trace)).toEqual({ outcome: "FAILED" });
    expect((await readSuggestionAsService(GRADER, id))?.adjudication).toMatchObject({ decision: "CURATOR_REVIEW", failure: "the policy could not be asked (opa_unreachable)", modelId: null });
    expect(sent).toHaveLength(0);
  });

  it("steps 8 and 9 by rule: a floor decline is an intake-rules row with six lines from the grades, the sensors and decided records once each and in that order, and INTAKE_DECLINED (33 § 3.1, § 6)", async () => {
    const id = await writtenDraft(consenting);
    await item(consenting, id, REFUSED);
    const workflowId = `suggestion:${id}`;
    const trace = randomBytes(16).toString("hex");
    const activities = suggestionActivities(depsOf());
    await activities.recordSubmitted(id, workflowId);
    await activities.runIntake(id);
    expect(await activities.recordGraded(id, workflowId, 1, trace)).toEqual({ score: 0, strongestTier: null });
    expect(await activities.routeSuggestion(id, 0, null, PASSES)).toEqual({ route: "DECLINE_AT_INTAKE", namedTier: null });
    const decided = { by: "intake-rules", decision: "DECLINE", failingSensor: null, namedTier: null } as const;
    expect(await activities.recordDecision(id, workflowId, 1, trace, decided)).toEqual({ state: "INTAKE_DECLINED", decision: "DECLINE", sufficientTier: null });
    /* the step run again does nothing twice */
    expect(await activities.recordDecision(id, workflowId, 1, trace, decided)).toEqual({ state: "INTAKE_DECLINED", decision: "DECLINE", sufficientTier: null });

    const row = await readSuggestionAsService(GRADER, id);
    expect(row).toMatchObject({ state: "INTAKE_DECLINED", outcome: "DECLINE" });
    expect(row?.decidedAt).not.toBeNull();
    expect(row?.adjudication).toMatchObject({ decision: "DECLINE", decidedBy: "intake-rules", score: 0, acceptAt: 40, floorAt: 5, sufficientTier: null, modelId: null, guideVersion: null, promptSha256: null, failure: null, traceId: trace });
    expect(row?.criteria.map((line) => [line.criterion, line.verdict])).toEqual([["corroboration", "none"], ["independence", "none"], ["recency", "none"], ["relevance", "none"], ["threshold", "0<5"], ["tier", "none"]]);
    const records = await view({ suggestionId: id });
    expect(records.map((record) => [record.kind, record.actor])).toEqual([["SUBMITTED", `user:${CONSENTING}`], ["GRADED", "service:grader"], ["SENSORS", "service:intake"], ["DECIDED", "service:intake"]]);
    expect(records[2]?.payload).toEqual({ stepKey: sha256Hex(`${workflowId}:sensors:1`), rubricVersion: "v1.2", origin: "HUMAN", verdicts: PASSES, parts: ["P2"], detailSha256: detailSha256Of(row?.sensorVerdicts ?? []) });
    expect(records[3]?.payload).toEqual({
      stepKey: sha256Hex(`${workflowId}:decided:1`),
      rubricVersion: "v1.2",
      origin: "HUMAN",
      decision: "DECLINE",
      decidedBy: "intake-rules",
      score: 0,
      acceptAt: 40,
      floorAt: 5,
      sufficientTier: null,
      failingSensor: null,
      criteria: (row?.criteria ?? []).map((line) => ({ name: line.criterion, verdict: line.verdict, reasonSha256: sha256Hex(line.reason) })),
      guide: null,
      modelId: null,
      promptSha256: null,
      usage: NO_USAGE,
      traceId: trace,
    });
  });

  it("steps 8 and 9 after a failing intake sensor: submitted, sensors, decided — no graded record — and INTAKE_DECLINED naming the sensor (33 § 6.2)", async () => {
    const id = await writtenDraft(consenting);
    await item(consenting, id, VENDOR);
    const workflowId = `suggestion:${id}`;
    const trace = randomBytes(16).toString("hex");
    const gone = suggestionActivities(depsOf({ anchor: async () => null }));
    await gone.recordSubmitted(id, workflowId);
    expect((await gone.runIntake(id)).find((verdict) => verdict.result === "FAIL")).toEqual({ sensor: "ANCHOR_EXISTS", result: "FAIL" });
    expect(await gone.recordDecision(id, workflowId, 1, trace, { by: "intake-rules", decision: "DECLINE", failingSensor: "ANCHOR_EXISTS", namedTier: null })).toEqual({ state: "INTAKE_DECLINED", decision: "DECLINE", sufficientTier: null });
    expect((await view({ suggestionId: id })).map((record) => record.kind)).toEqual(["SUBMITTED", "SENSORS", "DECIDED"]);
    const row = await readSuggestionAsService(GRADER, id);
    expect(row?.adjudication).toMatchObject({ decidedBy: "intake-rules", decision: "DECLINE", failingSensor: "ANCHOR_EXISTS", score: 56 });
    expect(row?.criteria.find((line) => line.criterion === "threshold")).toMatchObject({ verdict: "56>=40", reason: "Declined by the ANCHOR_EXISTS sensor before any adjudicator, whatever the score." });
    expect(row?.criteria.find((line) => line.criterion === "tier")).toMatchObject({ verdict: "C", reason: VENDOR.reason });
  });

  it("steps 8 and 9 by the adjudicator: its accept leaves a person's suggestion DECIDED, its decided record carrying the guide, the model, the prompt, the criteria and the call's tokens (33 § 6.1)", async () => {
    const { id, workflowId, trace } = await sensedAndGraded();
    const activities = suggestionActivities(depsOf());
    await activities.adjudicateSuggestion(id, workflowId, 1, trace);
    /* a budget's wait marked and never cleared — its run ended mid-sleep — goes with the decision's move (the review of 50f) */
    await activities.markBudgetWait(id, "2026-11-01T00:00:00.000Z");
    adjudicationAsked.length = 0;
    expect(await activities.recordDecision(id, workflowId, 1, trace, { by: "adjudicator" })).toEqual({ state: "DECIDED", decision: "ACCEPT", sufficientTier: null });
    const row = await readSuggestionAsService(GRADER, id);
    expect(row).toMatchObject({ state: "DECIDED", outcome: "ACCEPT", budgetResetsAt: null });
    const records = await view({ suggestionId: id });
    expect(records.map((record) => record.kind)).toEqual(["SUBMITTED", "GRADED", "SENSORS", "DECIDED"]);
    expect((records[2]?.payload as unknown as { readonly verdicts: ReadonlyArray<unknown> }).verdicts).toHaveLength(7);
    expect(records[3]).toMatchObject({
      actor: "service:adjudicator",
      payload: { decision: "ACCEPT", decidedBy: "adjudicator", score: 56, acceptAt: 40, floorAt: 5, guide: { version: "v2.1", sha256: loadGuide("adjudicator", "v2.1").sha256 }, modelId: row?.adjudication?.modelId, promptSha256: row?.adjudication?.promptSha256, usage: ADJUDICATION_USAGE, traceId: trace },
    });
    expect((records[3]?.payload as unknown as { readonly criteria: ReadonlyArray<unknown> }).criteria).toHaveLength(6);
    /* the call's tokens, asked of the contributor's principal since this attempt's graded record */
    expect(adjudicationAsked).toEqual([{ principal: { userId: CONSENTING }, suggestionId: id, since: records[1]?.createdAt }]);
  });

  it("steps 8 and 9 by the router, and for the adjudicator's failure: the curator's queue, with no row for a class no score decides and the failure's row as step 7 left it", async () => {
    const curator = await sensedAndGraded();
    await getPrisma().$executeRawUnsafe(`UPDATE "Suggestion" SET "changeClass" = 'CURATOR_ALWAYS', "curatorReason" = 'SAFETY_OT' WHERE "id" = '${curator.id}'`);
    const activities = suggestionActivities(depsOf());
    expect(await activities.recordDecision(curator.id, curator.workflowId, 1, curator.trace, { by: "router" })).toEqual({ state: "CURATOR_QUEUE", decision: "CURATOR_REVIEW", sufficientTier: null });
    expect((await readSuggestionAsService(GRADER, curator.id))?.adjudication).toBeNull();
    expect((await view({ suggestionId: curator.id })).find((record) => record.kind === "DECIDED")).toMatchObject({
      actor: "service:intake",
      payload: { decision: "CURATOR_REVIEW", decidedBy: "router", score: 56, acceptAt: null, floorAt: null, criteria: [], guide: null, modelId: null, promptSha256: null, usage: NO_USAGE },
    });

    const failed = await sensedAndGraded();
    await getPrisma().$executeRawUnsafe(`UPDATE "Suggestion" SET "rationale" = 'A rationale written after it was recorded.' WHERE "id" = '${failed.id}'`);
    expect(await activities.adjudicateSuggestion(failed.id, failed.workflowId, 1, failed.trace)).toEqual({ outcome: "FAILED" });
    expect(await activities.recordDecision(failed.id, failed.workflowId, 1, failed.trace, { by: "adjudicator" })).toEqual({ state: "CURATOR_QUEUE", decision: "CURATOR_REVIEW", sufficientTier: null });
    expect((await readSuggestionAsService(GRADER, failed.id))?.outcome).toBe("CURATOR_REVIEW");
    expect((await view({ suggestionId: failed.id })).find((record) => record.kind === "DECIDED")).toMatchObject({
      actor: "service:adjudicator",
      payload: { decision: "CURATOR_REVIEW", decidedBy: "adjudicator", guide: { version: "v2.1" }, modelId: null, promptSha256: null, criteria: [] },
    });
  });

  /** A curator's action as the decision endpoint writes it (36 § 5.1 step 4), on a suggestion in the queue. */
  async function curatorAction(suggestionId: string, action: "ACCEPT" | "KEEP_REQUEST_MORE" | "DECLINE", over: { readonly overrideCode?: string; readonly criterion?: string; readonly createdAt?: Date } = {}): Promise<string> {
    const id = randomUUID();
    await getPrisma().curatorAction.create({ data: { id, suggestionId, curatorId: CURATOR, action, overrideCode: over.overrideCode ?? null, criterion: over.criterion ?? null, note: `The suite's curator: ${action}.`, queueWaitMs: 60_000, ...(over.createdAt === undefined ? {} : { createdAt: over.createdAt }) } });
    return id;
  }

  /** A wording change the adjudicator asked more for, through the decision, waiting in the queue (attempt 1). */
  async function askedForMore(): Promise<{ readonly id: SuggestionId; readonly workflowId: string }> {
    const id = await writtenDraft(consenting);
    await item(consenting, id, PARTIAL);
    const workflowId = `suggestion:${id}`;
    const trace = randomBytes(16).toString("hex");
    const activities = suggestionActivities(depsOf());
    await activities.recordSubmitted(id, workflowId);
    await activities.runIntake(id);
    expect(await activities.recordGraded(id, workflowId, 1, trace)).toMatchObject({ score: 33 });
    await activities.runConsistency(id);
    expect(await activities.adjudicateSuggestion(id, workflowId, 1, trace)).toMatchObject({ outcome: "DECIDED", decision: "REQUEST_MORE" });
    expect(await activities.recordDecision(id, workflowId, 1, trace, { by: "adjudicator" })).toMatchObject({ state: "CURATOR_QUEUE", decision: "REQUEST_MORE" });
    return { id, workflowId };
  }

  /** When the decision that stands was made: what a revision of it carries (33 § 20). */
  const decidedAtOf = async (id: string): Promise<string> => (await readSuggestionAsService(GRADER, id))?.decidedAt?.toISOString() ?? "none";

  it("a curator's decision in the queue: the curator record and the calibration event once each, then the move; an action of another suggestion is nothing to record (33 § 6.3, invariant 17)", async () => {
    const { id, workflowId, trace } = await sensedAndGraded();
    await getPrisma().$executeRawUnsafe(`UPDATE "Suggestion" SET "changeClass" = 'CURATOR_ALWAYS', "curatorReason" = 'SAFETY_OT' WHERE "id" = '${id}'`);
    const activities = suggestionActivities(depsOf());
    expect(await activities.recordDecision(id, workflowId, 1, trace, { by: "router" })).toMatchObject({ state: "CURATOR_QUEUE" });

    const other = await sensedAndGraded();
    expect(await activities.recordCuratorDecision(id, workflowId, await curatorAction(other.id, "ACCEPT"))).toEqual({ recorded: false });
    expect(await activities.recordCuratorDecision(id, workflowId, randomUUID())).toEqual({ recorded: false });

    const action = await curatorAction(id, "ACCEPT");
    expect(await activities.recordCuratorDecision(id, workflowId, action)).toEqual({ recorded: true, state: "MERGING", decision: "ACCEPT" });
    /* the step run again does nothing twice */
    expect(await activities.recordCuratorDecision(id, workflowId, action)).toEqual({ recorded: true, state: "MERGING", decision: "ACCEPT" });
    expect(await readSuggestionAsService(GRADER, id)).toMatchObject({ state: "MERGING", outcome: "ACCEPT" });
    const curated = (await view({ suggestionId: id })).filter((record) => record.kind === "CURATOR");
    expect(curated).toHaveLength(1);
    expect(curated[0]).toMatchObject({
      actor: `user:${CURATOR}`,
      payload: { stepKey: sha256Hex(`${workflowId}:curator:${action}`), rubricVersion: "v1.2", origin: "HUMAN", action: "ACCEPT", overrideCode: null, criterion: null, noteSha256: sha256Hex("The suite's curator: ACCEPT."), seeded: false, seedMatched: null, queueWaitMs: 60_000, part: "P2" },
    });
    const events = await getPrisma().calibrationEvent.findMany({ where: { suggestionId: id } });
    expect(events).toHaveLength(1);
    /* a curator-always change: no adjudicator side (36 § 5.2) */
    expect(events[0]).toMatchObject({ curatorActionId: action, curatorAction: "ACCEPT", adjudicatorDecision: null, adjudicatorScore: null, overrideCode: null, seeded: false, rubricVersionId: "v1.2" });
    /* past the queue, a second curator's action is nothing to record */
    expect(await activities.recordCuratorDecision(id, workflowId, await curatorAction(id, "DECLINE"))).toEqual({ recorded: false });

    /* in the queue: an action made before this visit began, and one whose criterion the record does not take, are none of it, and fail nothing (33 § 20) */
    const queued = await sensedAndGraded();
    await getPrisma().$executeRawUnsafe(`UPDATE "Suggestion" SET "changeClass" = 'CURATOR_ALWAYS', "curatorReason" = 'SAFETY_OT' WHERE "id" = '${queued.id}'`);
    await activities.recordDecision(queued.id, queued.workflowId, 1, queued.trace, { by: "router" });
    expect(await activities.recordCuratorDecision(queued.id, queued.workflowId, await curatorAction(queued.id, "ACCEPT", { createdAt: new Date("2026-01-01T00:00:00.000Z") }))).toEqual({ recorded: false });
    expect(await activities.recordCuratorDecision(queued.id, queued.workflowId, await curatorAction(queued.id, "ACCEPT", { criterion: "novelty" }))).toEqual({ recorded: false });
    expect(await readSuggestionAsService(GRADER, queued.id)).toMatchObject({ state: "CURATOR_QUEUE" });
    expect((await view({ suggestionId: queued.id })).filter((record) => record.kind === "CURATOR")).toHaveLength(0);
  });

  it("a request for more the adjudicator made and a curator kept: DECIDED, its calibration event with the adjudicator's side; and a revision's return with its own submitted record, whose rationale the adjudicator then checks (33 § 6.3, § 6.4)", async () => {
    const { id, workflowId } = await askedForMore();
    const activities = suggestionActivities(depsOf());

    const kept = await curatorAction(id, "KEEP_REQUEST_MORE");
    expect(await activities.recordCuratorDecision(id, workflowId, kept)).toEqual({ recorded: true, state: "DECIDED", decision: "REQUEST_MORE" });
    expect(await getPrisma().calibrationEvent.findUnique({ where: { curatorActionId: kept } })).toMatchObject({ curatorAction: "KEEP_REQUEST_MORE", adjudicatorDecision: "REQUEST_MORE", adjudicatorScore: 33 });

    /* the contributor revises the rationale and submits: the workflow returns it and records the attempt's submission */
    const revised = "The vendor's page and the section's own lab together show every step retried.";
    expect(await updateDraft(consenting, id, { rationale: revised })).not.toBeNull();
    const answered = await decidedAtOf(id);
    /* a revision sent against an earlier decision answers none */
    expect(await activities.reopenForRevision(id, workflowId, 2, "2026-01-01T00:00:00.000Z")).toEqual({ reopened: false });
    expect(await activities.reopenForRevision(id, workflowId, 2, answered)).toEqual({ reopened: true });
    /* run again, it does nothing twice */
    expect(await activities.reopenForRevision(id, workflowId, 2, answered)).toEqual({ reopened: true });
    expect((await readSuggestionAsService(GRADER, id))?.state).toBe("SUBMITTED");
    const submissions = (await view({ suggestionId: id })).filter((record) => record.kind === "SUBMITTED");
    expect(submissions.map((record) => (record.payload as { readonly stepKey: string }).stepKey)).toEqual([sha256Hex(`${workflowId}:submitted:1`), sha256Hex(`${workflowId}:submitted:2`)]);
    expect(submissions[1]).toMatchObject({ actor: `user:${CONSENTING}`, payload: { rationaleSha256: sha256Hex(revised), rationaleWords: countWords(revised) } });

    /* attempt 2 runs again, and its adjudication checks the revised rationale against the second submission, not the first */
    const second = randomBytes(16).toString("hex");
    await activities.runIntake(id);
    await activities.recordGraded(id, workflowId, 2, second);
    await activities.runConsistency(id);
    expect(await activities.adjudicateSuggestion(id, workflowId, 2, second)).toMatchObject({ outcome: "DECIDED", decision: "REQUEST_MORE" });
    /* the second decision, made later, as a real clock makes it */
    const later = suggestionActivities(depsOf({ now: () => new Date("2026-10-07T13:00:00.000Z") }));
    expect(await later.recordDecision(id, workflowId, 2, second, { by: "adjudicator" })).toMatchObject({ state: "CURATOR_QUEUE", decision: "REQUEST_MORE" });
    /* the first decision's revision, sent again, answers none now the second stands */
    expect(await activities.reopenForRevision(id, workflowId, 3, answered)).toEqual({ reopened: false });
  });

  /** The instant of a contributor's request to withdraw, as the endpoint writes it (45 § 5.2). */
  const WITHDRAWN_AT = new Date("2026-10-11T12:00:00.000Z");

  it("a contributor's withdrawal where the run waits: the retracted record once, then CLOSED with its decision kept and the request's instant; run again it does nothing twice, and a take-back after it changes nothing (45 § 5.3)", async () => {
    const { id, workflowId } = await askedForMore();
    const activities = suggestionActivities(depsOf());
    const decidedAt = await decidedAtOf(id);
    expect(await requestWithdrawal(consenting, id, WITHDRAWN_AT)).toEqual({ requested: true, at: WITHDRAWN_AT, decidedAt: new Date(decidedAt) });
    const signal = { userId: CONSENTING, at: WITHDRAWN_AT.toISOString(), decidedAt };
    expect(await activities.recordWithdrawal(id, workflowId, signal)).toEqual({ recorded: true });
    expect(await activities.recordWithdrawal(id, workflowId, signal)).toEqual({ recorded: true });
    const retracted = (await view({ suggestionId: id })).filter((record) => record.kind === "RETRACTED");
    expect(retracted).toHaveLength(1);
    expect(retracted[0]).toMatchObject({
      actor: `user:${CONSENTING}`,
      chapterVersionId: CHAPTER_VERSION,
      payload: { stepKey: sha256Hex(`${workflowId}:retracted:${WITHDRAWN_AT.toISOString()}`), rubricVersion: "v1.2", origin: "HUMAN", from: "CURATOR_QUEUE", outcome: "REQUEST_MORE" },
    });
    /* the decision that stood and its time stay, for the throttle; no curator's event is written */
    expect(await readSuggestionAsService(GRADER, id)).toMatchObject({ state: "CLOSED", outcome: "REQUEST_MORE", decidedAt: new Date(decidedAt), withdrawnAt: WITHDRAWN_AT, closedAt: new Date("2026-10-07T12:00:00.000Z") });
    expect(await getPrisma().calibrationEvent.count({ where: { suggestionId: id } })).toBe(0);
    expect(await takeBackWithdrawal(consenting, id, WITHDRAWN_AT)).toBe(false);
    expect((await readSuggestionAsService(GRADER, id))?.withdrawnAt).toEqual(WITHDRAWN_AT);
  });

  it("a withdrawal that no longer stands records nothing, and takes back its request only as it was: another person's, a decision since, a curator's action first; another instant's is left alone (45 § 5.3)", async () => {
    const activities = suggestionActivities(depsOf());
    const requested = async (): Promise<{ readonly id: SuggestionId; readonly workflowId: string; readonly decidedAt: string }> => {
      const made = await askedForMore();
      const decidedAt = await decidedAtOf(made.id);
      expect(await requestWithdrawal(consenting, made.id, WITHDRAWN_AT)).toMatchObject({ requested: true });
      return { ...made, decidedAt };
    };
    const signal = (decidedAt: string, over: { readonly userId?: string; readonly at?: string; readonly decidedAt?: string } = {}) => ({ userId: CONSENTING, at: WITHDRAWN_AT.toISOString(), decidedAt, ...over });

    const anotherPerson = await requested();
    expect(await activities.recordWithdrawal(anotherPerson.id, anotherPerson.workflowId, signal(anotherPerson.decidedAt, { userId: THROTTLED }))).toEqual({ recorded: false });
    const decisionSince = await requested();
    expect(await activities.recordWithdrawal(decisionSince.id, decisionSince.workflowId, signal(decisionSince.decidedAt, { decidedAt: "2026-01-01T00:00:00.000Z" }))).toEqual({ recorded: false });
    const curatorFirst = await requested();
    await curatorAction(curatorFirst.id, "ACCEPT");
    expect(await activities.recordWithdrawal(curatorFirst.id, curatorFirst.workflowId, signal(curatorFirst.decidedAt))).toEqual({ recorded: false });
    const anotherInstant = await requested();
    expect(await activities.recordWithdrawal(anotherInstant.id, anotherInstant.workflowId, signal(anotherInstant.decidedAt, { at: "2026-10-11T12:05:00.000Z" }))).toEqual({ recorded: false });

    for (const [each, left] of [[anotherPerson, null], [decisionSince, null], [curatorFirst, null], [anotherInstant, WITHDRAWN_AT]] as const) {
      expect(await readSuggestionAsService(GRADER, each.id), each.id).toMatchObject({ state: "CURATOR_QUEUE", withdrawnAt: left });
      expect((await view({ suggestionId: each.id })).filter((record) => record.kind === "RETRACTED"), each.id).toHaveLength(0);
    }
  });

  it("a curator's decision recorded first ends a request standing with it; and a take-back between a withdrawal's record and its move is undone by the move, so the row follows its record (45 § 5.3)", async () => {
    const activities = suggestionActivities(depsOf());
    const curatorFirst = await askedForMore();
    await requestWithdrawal(consenting, curatorFirst.id, WITHDRAWN_AT);
    expect(await activities.recordCuratorDecision(curatorFirst.id, curatorFirst.workflowId, await curatorAction(curatorFirst.id, "KEEP_REQUEST_MORE"))).toEqual({ recorded: true, state: "DECIDED", decision: "REQUEST_MORE" });
    expect((await readSuggestionAsService(GRADER, curatorFirst.id))?.withdrawnAt).toBeNull();

    /* the step appended its record, then the endpoint, told the engine was late, took the request back, then the step moved */
    const raced = await askedForMore();
    const decidedAt = await decidedAtOf(raced.id);
    await requestWithdrawal(consenting, raced.id, WITHDRAWN_AT);
    const stepKey = stepKeyOf(raced.workflowId, `retracted:${WITHDRAWN_AT.toISOString()}`);
    await appendOnce({ kind: "RETRACTED", actor: `user:${CONSENTING}`, suggestionId: raced.id, chapterVersionId: CHAPTER_VERSION, payload: { stepKey, rubricVersion: "v1.2", origin: "HUMAN", from: "CURATOR_QUEUE", outcome: "REQUEST_MORE" } }, stepKey);
    expect(await takeBackWithdrawal(consenting, raced.id, WITHDRAWN_AT)).toBe(true);
    expect(await activities.recordWithdrawal(raced.id, raced.workflowId, { userId: CONSENTING, at: WITHDRAWN_AT.toISOString(), decidedAt })).toEqual({ recorded: true });
    expect(await readSuggestionAsService(GRADER, raced.id)).toMatchObject({ state: "CLOSED", withdrawnAt: WITHDRAWN_AT });
    expect((await view({ suggestionId: raced.id })).filter((record) => record.kind === "RETRACTED")).toHaveLength(1);
  });

  it("a request and a curator's decline written in the same instant: the decline is recorded first and ends the request, which then records nothing; a request left stale by a merge's return records nothing either (45 § 5.3, § 8)", async () => {
    const activities = suggestionActivities(depsOf());
    /* the curator's action as the race leaves it — written beside the request, which writeCuratorAction alone would refuse */
    const declined = await askedForMore();
    const declinedAt = await decidedAtOf(declined.id);
    await requestWithdrawal(consenting, declined.id, WITHDRAWN_AT);
    expect(await activities.recordCuratorDecision(declined.id, declined.workflowId, await curatorAction(declined.id, "DECLINE"))).toEqual({ recorded: true, state: "CLOSED", decision: "DECLINE" });
    expect(await readSuggestionAsService(GRADER, declined.id)).toMatchObject({ state: "CLOSED", withdrawnAt: null });
    expect(await activities.recordWithdrawal(declined.id, declined.workflowId, { userId: CONSENTING, at: WITHDRAWN_AT.toISOString(), decidedAt: declinedAt })).toEqual({ recorded: false });
    expect((await view({ suggestionId: declined.id })).filter((record) => record.kind === "RETRACTED")).toHaveLength(0);

    /* accepted in the queue, then returned by the merge as a request for more: the request was made against the queue's decision, not this one */
    const returned = await askedForMore();
    const queuedAt = await decidedAtOf(returned.id);
    await requestWithdrawal(consenting, returned.id, WITHDRAWN_AT);
    const later = suggestionActivities(depsOf({ now: () => new Date("2026-10-07T13:00:00.000Z") }));
    expect(await later.recordCuratorDecision(returned.id, returned.workflowId, await curatorAction(returned.id, "ACCEPT"))).toMatchObject({ recorded: true, state: "MERGING" });
    await moveAlong({ kind: "service", id: "service:merge" }, returned.id, ["MERGING", "DECIDED"], { outcome: "REQUEST_MORE", decidedAt: new Date("2026-10-07T14:00:00.000Z") });
    expect(await activities.recordWithdrawal(returned.id, returned.workflowId, { userId: CONSENTING, at: WITHDRAWN_AT.toISOString(), decidedAt: queuedAt })).toEqual({ recorded: false });
    expect(await readSuggestionAsService(GRADER, returned.id)).toMatchObject({ state: "DECIDED", outcome: "REQUEST_MORE", withdrawnAt: null });
    expect((await view({ suggestionId: returned.id })).filter((record) => record.kind === "RETRACTED")).toHaveLength(0);
  });

  it("a router's decision after an adjudicator's takes the earlier attempt's rows away, so the calibration event has no adjudicator side for a visit no adjudicator decided (the review of part 2)", async () => {
    const { id, workflowId } = await askedForMore();
    const activities = suggestionActivities(depsOf());
    await activities.recordCuratorDecision(id, workflowId, await curatorAction(id, "KEEP_REQUEST_MORE"));
    expect(await activities.reopenForRevision(id, workflowId, 2, await decidedAtOf(id))).toEqual({ reopened: true });
    /* attempt 2 goes to a curator by the router: a class no score decides */
    await getPrisma().$executeRawUnsafe(`UPDATE "Suggestion" SET "changeClass" = 'CURATOR_ALWAYS', "curatorReason" = 'SAFETY_OT' WHERE "id" = '${id}'`);
    const second = randomBytes(16).toString("hex");
    await activities.runIntake(id);
    await activities.recordGraded(id, workflowId, 2, second);
    await activities.runConsistency(id);
    expect(await activities.recordDecision(id, workflowId, 2, second, { by: "router" })).toMatchObject({ state: "CURATOR_QUEUE", decision: "CURATOR_REVIEW" });
    const row = await readSuggestionAsService(GRADER, id);
    expect(row?.adjudication).toBeNull();
    expect(row?.criteria).toEqual([]);
    const accepted = await curatorAction(id, "ACCEPT");
    expect(await activities.recordCuratorDecision(id, workflowId, accepted)).toMatchObject({ recorded: true, state: "MERGING" });
    expect(await getPrisma().calibrationEvent.findUnique({ where: { curatorActionId: accepted } })).toMatchObject({ adjudicatorDecision: null, adjudicatorScore: null });
  });

  it("opens a rubric review when a decision takes a criterion's rate past 20 % in its quarter, and a second decision the same quarter opens no second (36 § 6.3, § 11.6)", async () => {
    /* The suite's quarter is 2099-Q1, which nothing real reaches: its events and its review are its own. */
    const at = (iso: string) => suggestionActivities(depsOf({ now: () => new Date(iso) }));
    const first = await askedForMore();
    const second = await askedForMore();
    /* Before them, nineteen decisions of the quarter on what the adjudicator asked more for: four overrides on independence, fifteen kept. */
    const prior = (criterion: string | null, curatorAction: "ACCEPT" | "KEEP_REQUEST_MORE") => ({ suggestionId: first.id, criterion, adjudicatorDecision: "REQUEST_MORE" as const, adjudicatorScore: 33, curatorAction, overrideCode: criterion === null ? null : "OV-IND-02", seeded: false, rubricVersionId: "v1.2", createdAt: new Date("2099-01-20T00:00:00.000Z") });
    await getPrisma().calibrationEvent.createMany({ data: [...Array.from({ length: 4 }, () => prior("independence", "ACCEPT")), ...Array.from({ length: 15 }, () => prior(null, "KEEP_REQUEST_MORE"))] });

    /* The twentieth, a fifth override on independence: 5 of 20, 25 %, past the line. */
    const overridden = await curatorAction(first.id, "ACCEPT", { overrideCode: "OV-IND-02", criterion: "independence" });
    expect(await at("2099-02-01T00:00:00.000Z").recordCuratorDecision(first.id, first.workflowId, overridden)).toMatchObject({ recorded: true, state: "MERGING" });
    const opened = await getPrisma().rubricReview.findMany({ where: { quarter: "2099-Q1" } });
    expect(opened).toEqual([expect.objectContaining({ criterion: "independence", rubricVersionId: "v1.2", overridden: 5, reviewed: 20, rate: 0.25 })]);
    expect(opened[0]?.id).toMatch(/^R-1\.2-\d{4}$/);

    /* The twenty-first, kept: 5 of 21 is still past the line, and the review there is the one. */
    expect(await at("2099-02-02T00:00:00.000Z").recordCuratorDecision(second.id, second.workflowId, await curatorAction(second.id, "KEEP_REQUEST_MORE"))).toMatchObject({ recorded: true, state: "DECIDED" });
    expect(await getPrisma().rubricReview.findMany({ where: { quarter: "2099-Q1" }, select: { id: true } })).toEqual([{ id: opened[0]?.id }]);
  });

  it("the adjudicator's decision is recorded without its contributor's account, or a rubric the workers can load: no tokens to count, the thresholds its row holds (the review of part 1)", async () => {
    const { id, workflowId, trace } = await sensedAndGraded();
    await suggestionActivities(depsOf()).adjudicateSuggestion(id, workflowId, 1, trace);
    await getPrisma().$executeRawUnsafe(`UPDATE "Suggestion" SET "userId" = NULL WHERE "id" = '${id}'`);
    const unloadable = suggestionActivities(depsOf({ loadRubric: (version) => ({ ...loadRubric(version), sha256: "f".repeat(64) }) }));
    expect(await unloadable.recordDecision(id, workflowId, 1, trace, { by: "adjudicator" })).toEqual({ state: "DECIDED", decision: "ACCEPT", sufficientTier: null });
    expect((await view({ suggestionId: id })).find((record) => record.kind === "DECIDED")).toMatchObject({ payload: { decision: "ACCEPT", acceptAt: 40, floorAt: 5, usage: NO_USAGE } });

    /* a failure to read the rubric that is not its being unpublishable is the engine's to retry, and no record is written without it (the review of part 2) */
    const routed = await sensedAndGraded();
    const flaky = suggestionActivities(
      depsOf({
        rubricVersion: async () => {
          throw new Error("the connection was reset");
        },
      }),
    );
    await expect(flaky.recordDecision(routed.id, routed.workflowId, 1, routed.trace, { by: "router" })).rejects.toThrow("the connection was reset");
    expect((await view({ suggestionId: routed.id })).filter((record) => record.kind === "DECIDED")).toHaveLength(0);
  });

  /** A suggestion of `caller`'s with one item so graded, through to a decline by rule. */
  async function declinedWith(caller: UserCaller, grade: ItemGrade): Promise<SuggestionId> {
    const id = await writtenDraft(caller);
    await item(caller, id, grade);
    const workflowId = `suggestion:${id}`;
    const trace = randomBytes(16).toString("hex");
    const activities = suggestionActivities(depsOf());
    await activities.recordSubmitted(id, workflowId);
    await activities.runIntake(id);
    await activities.recordGraded(id, workflowId, 1, trace);
    await activities.recordDecision(id, workflowId, 1, trace, { by: "intake-rules", decision: "DECLINE", failingSensor: null, namedTier: null });
    return id;
  }

  it("the throttle: the third decline on unverifiable evidence in thirty days pauses the contributor for thirty days; a decline on tier G, and one older than thirty days, do not count (33 § 7, § 11.10)", async () => {
    const activities = suggestionActivities(depsOf());
    expect(await activities.throttleOnDecline(await declinedWith(throttled, REFUSED))).toEqual({ throttledUntil: null });
    expect(await activities.throttleOnDecline(await declinedWith(throttled, REFUSED))).toEqual({ throttledUntil: null });
    /* graded G, not U: it does not count */
    expect(await activities.throttleOnDecline(await declinedWith(throttled, SCREENSHOT))).toEqual({ throttledUntil: null });
    expect((await contributorStandingOf({ id: THROTTLED })).throttledUntil).toBeNull();
    /* the third on unverifiable evidence: thirty days from the decision's day */
    expect(await activities.throttleOnDecline(await declinedWith(throttled, REFUSED))).toEqual({ throttledUntil: "2026-11-06T12:00:00.000Z" });
    expect((await contributorStandingOf({ id: THROTTLED })).throttledUntil?.toISOString()).toBe("2026-11-06T12:00:00.000Z");

    /* declines older than thirty days are out of the window, and a pause already set is never brought forward */
    await getPrisma().$executeRawUnsafe(`UPDATE "Suggestion" SET "decidedAt" = '2026-08-01T00:00:00Z' WHERE "userId" = '${THROTTLED}'`);
    const late = await declinedWith(throttled, REFUSED);
    expect(await activities.throttleOnDecline(late)).toEqual({ throttledUntil: null });
    expect((await contributorStandingOf({ id: THROTTLED })).throttledUntil?.toISOString()).toBe("2026-11-06T12:00:00.000Z");
    /* no decline, nothing to count: a suggestion only submitted */
    const { id: open } = await submitted();
    expect(await activities.throttleOnDecline(open)).toEqual({ throttledUntil: null });
  });

  it("step 4: routes by the suggestion's own rubric with this attempt's verdicts, and declines at any score on a failed one", async () => {
    const { id } = await submitted();
    const rules = loadRubric("v1.2").rubric;
    const activities = suggestionActivities(depsOf());
    expect(await activities.routeSuggestion(id, 56, "C", PASSES)).toEqual(routeOf(rules, { changeClass: "WORDING", score: 56, verdicts: PASSES, strongestTier: "C" }));
    const failed = PASSES.map((verdict) => (verdict.sensor === "SCHEMA" ? { ...verdict, result: "FAIL" as const } : verdict));
    expect(await activities.routeSuggestion(id, 100, "B", failed)).toEqual({ route: "DECLINE_AT_INTAKE", namedTier: null });
  });
});
