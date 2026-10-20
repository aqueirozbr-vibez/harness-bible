import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultResearchFindingEndpointDeps, researchFindingEndpoints, type ResearchFindingEndpointDeps } from "@/lib/api/endpoints/researchFindings";
import { defaultDeps, handler, type HandlerDeps } from "@/lib/api/handler";
import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { resolveAnchor } from "@/lib/db/anchors";
import { getPrisma } from "@/lib/db/client";
import { callerOf, createFromResearch, liveSuggestionWithKey, readSuggestion } from "@/lib/db/improve";
import { askerOfProposal, deleteResearchConversation, DETACHED_RUN_KEPT_MS, duplicateVisibleTo, noteOfDraft, readFindingToSend, readProposalsOfAsker, readResearchRunView, sendFindingTx, sweepDetachedRuns, type FindingRef } from "@/lib/db/research";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { findingKeyOf, submissionOf } from "@/lib/research/submission";
import { ReaderFindingSchema, ResearchFoundSchema, type ReaderFinding } from "@/lib/schemas/researcher";
import { RESEARCH_SENDS_PER_MONTH, sendsMonthOf } from "@/lib/schemas/research";
import { WorkflowsUnavailableError } from "@/lib/workflows/client";
import { clearResearchPage, seedResearchPage, type ResearchPageSeed } from "@/tests/fixtures/research/page";
import { defaultOutcomeStepDeps, defaultSendStepDeps, outcomeStep, RESEARCHER, sendStep, type SendStepDeps } from "@/workers/research/send";

/*
 * A finding turned into an improvement against the database (feature-specs/48 § 8, § 13, § 26; unit 74), on the rows
 * the research seed writes (tests/fixtures/research/page.ts) for the suite's own accounts — the done research's two
 * findings that passed the checks, a claim on 21.3 with two sources and a figure's value, and the purged research's
 * unused one. The policy allows (its rules are policies/tests/research_test.rego's, and the contract suite's through the
 * sidecar), the rate is open, the idempotency table is the real one, and the engine is doubled: no workflow reaches the
 * development engine, whose workers would run it.
 *
 * - a verified contributor's draft: one transaction, the finding `DRAFTED` naming a draft with `fromResearch`, the
 *   proposal and its key, an empty rationale and one pending `LINK` item a source, each grading started on its own; a
 *   start that fails takes its item off and the rail lists that source, read again, not remembered; a replay is the
 *   same draft, a second press 409; the run's view opens the draft's edit page;
 * - the draft door's refusals: the throttle, another's finding, a purged run's, an anchor gone, a live suggestion with
 *   the key — its id only where the contributor may be told it;
 * - a reader's send: 202 with the workflow started under `finding:<id>` and nothing claimed; the step makes a
 *   researcher's proposal with no owner, the finding `SUBMITTED` with its `sentAt`; proposed, it is the asker's —
 *   `Add my name`'s check, Improve's proposals from their questions, the run's panel; a draft of the same change made
 *   before is checked again at its submission (§ 8.5), its key now live;
 * - the month's thirty (D5), read off the month's counter, research proposals unconfigured, the engine down: nothing
 *   changes;
 * - since unit 74's review, the counter itself: at twenty-nine a duplicate takes no place and a burst of presses makes
 *   exactly one more suggestion, the rest `SENDS_LIMIT` with nothing made; the month rolls over in UTC; the person's
 *   delete of a research and the sweep after it leave the count as it was; and a draft whose claim lost a race is told
 *   the finding's use in the view's words;
 * - each end of the send in its order, the finding left `VALID` with its code, which the next press clears;
 * - refuted, `sent · not proposed` with no id (D3); a detached refuted finding deleted with the write.
 *
 * Every suggestion the suite makes is moved back to draft and deleted after, as the improve harness clears its own: a
 * suggestion past draft is never deleted by the product (29 § 3), and a live one with the seed's keys would make the
 * same findings duplicates on every other account the seed writes.
 */

const ready = env.DATABASE_URL !== undefined;
const CONTRIBUTOR: SessionUser = { id: "00000000-0000-4000-8000-0000000a7401", organisationId: null, role: "CONTRIBUTOR", displayName: "Findings Contributor", locale: "en", identityVerified: true, parts: [], sessionId: null };
const READER: SessionUser = { id: "00000000-0000-4000-8000-0000000a7402", organisationId: null, role: "READER", displayName: "Findings Reader", locale: "en", identityVerified: false, parts: [], sessionId: null };
const OTHER: SessionUser = { id: "00000000-0000-4000-8000-0000000a7403", organisationId: null, role: "CONTRIBUTOR", displayName: "Findings Other", locale: "en", identityVerified: true, parts: [], sessionId: null };
/** A sender of the suite's own for the month's counter, whose findings are bare rows the send's read is given text for. */
const SENDER: SessionUser = { id: "00000000-0000-4000-8000-0000000a7404", organisationId: null, role: "READER", displayName: "Findings Sender", locale: "en", identityVerified: false, parts: [], sessionId: null };
const USERS = [CONTRIBUTOR, READER, OTHER, SENDER];

/** The engine as the endpoints see it: the gradings and the sends started, a grading's start that fails, an engine down. */
const engine = { graded: [] as string[], gradingFailsAt: null as number | null, sends: [] as Array<{ readonly findingId: string; readonly userId: string }>, down: false, configured: true, throttledUntil: null as Date | null, anchorGone: false };

const DEPS: ResearchFindingEndpointDeps = {
  ...defaultResearchFindingEndpointDeps,
  standing: async (user) => ({ ...(await defaultResearchFindingEndpointDeps.standing(user)), throttledUntil: engine.throttledUntil }),
  anchor: async (kind, id, locale) => (engine.anchorGone ? null : resolveAnchor(kind, id, locale)),
  startGrading: async (itemId) => {
    if (engine.gradingFailsAt === engine.graded.length) {
      engine.gradingFailsAt = null;
      throw new WorkflowsUnavailableError("connection", "the workflow engine could not be reached");
    }
    engine.graded.push(itemId);
  },
  configured: () => engine.configured,
  send: async (findingId, userId) => {
    if (engine.down) throw new WorkflowsUnavailableError("connection", "the workflow engine could not be reached");
    engine.sends.push({ findingId, userId });
  },
};

function pipeline(user: SessionUser): HandlerDeps {
  return { ...defaultDeps, sessionFromRequest: async () => user, authorize: async () => ({ allow: true }), consume: async () => ({ allowed: true, limit: 20, remaining: 19, resetS: 86_400, retryAfterS: 0 }), audit: async () => undefined, log: () => undefined };
}

const BASE = "http://localhost:3000";
const HEADERS = { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.74" };
const endpoints = researchFindingEndpoints(DEPS);
const draft = (user: SessionUser, id: string, key: string = randomUUID()) => handler(endpoints.researchFindingDraft, pipeline(user))(new Request(`${BASE}/api/v1/research/findings/${id}/draft`, { method: "POST", headers: { ...HEADERS, "idempotency-key": key }, body: JSON.stringify({ locale: "en" }) }), { params: { id } });
const propose = (user: SessionUser, id: string, key: string = randomUUID()) => handler(endpoints.researchFindingPropose, pipeline(user))(new Request(`${BASE}/api/v1/research/findings/${id}/propose`, { method: "POST", headers: { ...HEADERS, "idempotency-key": key }, body: "{}" }), { params: { id } });

/** The send's step on the database, its principal set as the workers would have it. */
const SEND: SendStepDeps = { ...defaultSendStepDeps(), principal: () => true };

/** A person's seeded findings: the done research's claim and value, and the purged research's unused one. */
interface Seeded {
  readonly seed: ResearchPageSeed;
  readonly claim: { readonly id: string; readonly runId: string; readonly finding: ReaderFinding };
  readonly value: { readonly id: string; readonly runId: string; readonly finding: ReaderFinding };
  readonly purged: string;
}

async function seeded(user: SessionUser): Promise<Seeded> {
  const seed = await seedResearchPage(user);
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const run = await prisma.researchRun.findFirstOrThrow({ where: { conversationId: seed.done, ordinal: 1 }, select: { id: true, found: true } });
    const found = ResearchFoundSchema.parse(run.found);
    const rows = await prisma.researchFinding.findMany({ where: { runId: run.id, outcome: "VALID" }, orderBy: { ordinal: "asc" }, select: { id: true, ordinal: true } });
    const [claim, value] = rows;
    const purged = await prisma.researchFinding.findFirstOrThrow({ where: { run: { conversationId: seed.purged }, outcome: "VALID" }, select: { id: true } });
    if (claim === undefined || value === undefined) throw new Error("the seed's done research has two findings that passed");
    const finding = (ordinal: number) => ReaderFindingSchema.parse(found.findings[ordinal - 1]);
    return { seed, claim: { id: claim.id, runId: run.id, finding: finding(claim.ordinal) }, value: { id: value.id, runId: run.id, finding: finding(value.ordinal) }, purged: purged.id };
  });
}

/** Every suggestion the suite made, back to draft and gone (29 § 3): its own, and the researcher's it sent. */
const made = new Set<string>();
async function clearSuggestions(ids: ReadonlyArray<string> = [...made]): Promise<void> {
  if (ids.length === 0) return;
  await withSystem(async () => {
    const prisma = getPrisma();
    await prisma.suggestion.updateMany({ where: { id: { in: [...ids] } }, data: { state: "DRAFT" } });
    await prisma.suggestion.deleteMany({ where: { id: { in: [...ids] }, state: "DRAFT" } });
  });
  for (const id of ids) made.delete(id);
}

const findingRow = (user: SessionUser, id: string) => withTenant(tenantOf(user), () => getPrisma().researchFinding.findUnique({ where: { id }, select: { outcome: true, suggestionId: true, failure: true, sentAt: true, runId: true } }));
const viewOf = async (user: SessionUser, runId: string, findingId: string) => (await readResearchRunView(user, runId))?.findings.find((finding) => finding.id === findingId) ?? null;
/** The month's counter (48 D5; review of unit 74): a person's count in a month, none being null, and set or taken away by the suite. */
const sendsOf = async (user: SessionUser, month: string): Promise<number | null> => (await withTenant(tenantOf(user), () => getPrisma().researchSendMonth.findFirst({ where: { month }, select: { count: true } })))?.count ?? null;
const setSends = (user: SessionUser, month: string, count: number | null) =>
  withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    await prisma.researchSendMonth.deleteMany({ where: { month } });
    if (count !== null) await prisma.researchSendMonth.create({ data: { userId: user.id, month, count } });
  });
const THIS_MONTH = sendsMonthOf(new Date()).month;
const placeAt = (id: string, state: "CURATOR_QUEUE" | "CLOSED" | "MERGED") => withSystem(() => getPrisma().suggestion.updateMany({ where: { id }, data: { state, ...(state === "CLOSED" ? { closedAt: new Date() } : {}) } }));

describe.skipIf(!ready)("a finding turned into an improvement, against the database (48 § 8)", () => {
  let contributor: Seeded;
  let reader: Seeded;

  beforeAll(async () => {
    await withSystem(async () => {
      for (const user of USERS) await getPrisma().user.upsert({ where: { id: user.id }, update: { role: user.role, identityVerified: user.identityVerified, throttledUntil: null }, create: { id: user.id, email: `${user.id}@research-findings.test`, displayName: user.displayName, role: user.role, identityVerified: user.identityVerified } });
    });
    contributor = await seeded(CONTRIBUTOR);
    reader = await seeded(READER);
  });

  afterAll(async () => {
    await clearSuggestions();
    for (const user of USERS) await clearResearchPage(user);
    /* the detached findings — a proposal the sweep kept, the sender's bare rows — have no key to the account */
    for (const user of USERS) await withTenant(tenantOf(user), () => getPrisma().researchFinding.deleteMany({ where: { runId: null } }));
    for (const user of USERS) await withTenant(tenantOf(user), () => getPrisma().idempotencyKey.deleteMany({}));
    await withSystem(() => getPrisma().user.deleteMany({ where: { id: { in: USERS.map((user) => user.id) } } }));
  });

  it("drafts a finding for a verified contributor: DRAFTED naming a draft from the research, its proposal and key, no rationale, a pending link a source graded on its own; a start that fails takes its item off, and the rail lists that source", async () => {
    engine.gradingFailsAt = 1;
    const key = randomUUID();
    const response = await draft(CONTRIBUTOR, contributor.claim.id, key);
    expect(response.status).toBe(201);
    const answer = (await response.json()) as { suggestionId: string; href: string; items: number };
    made.add(answer.suggestionId);
    expect(answer).toEqual({ suggestionId: expect.stringMatching(/^S-21-\d{4,}$/) as unknown as string, href: `/en/improve/${answer.suggestionId}/edit`, items: 1 });
    expect(await findingRow(CONTRIBUTOR, contributor.claim.id)).toMatchObject({ outcome: "DRAFTED", suggestionId: answer.suggestionId, sentAt: null });

    const suggestion = await withSystem(() => readSuggestion(callerOf(CONTRIBUTOR), answer.suggestionId));
    const resolved = await resolveAnchor("SECTION", "21.3", "en");
    if (suggestion === null || resolved === null) throw new Error("the draft and its anchor are there");
    expect(suggestion).toMatchObject({ origin: "HUMAN", userId: CONTRIBUTOR.id, fromResearch: true, state: "DRAFT", rationale: null, changeKind: "ADD_CLAIM", proposalKey: findingKeyOf(contributor.claim.finding, resolved) });
    expect(suggestion.proposal).toEqual(contributor.claim.finding.proposal);
    /* the second source's grading did not start: its item is gone, the first's graded on its own */
    expect(suggestion.evidence.map((item) => [item.kind, item.state, item.url])).toEqual([["LINK", "PENDING", contributor.claim.finding.sources[0]?.url]]);
    expect(engine.graded).toEqual([suggestion.evidence[0]?.id]);

    /* the rail: the note, never the rationale, and the source not among the evidence, read again */
    const note = await noteOfDraft(CONTRIBUTOR, answer.suggestionId);
    expect(note).toMatchObject({ note: contributor.claim.finding.note, contentLang: "en", research: { conversationId: contributor.seed.done, runId: contributor.claim.runId } });
    expect(note?.notAdded.map((source) => source.url)).toEqual([contributor.claim.finding.sources[1]?.url]);
    expect(await noteOfDraft(OTHER, answer.suggestionId)).toBeNull();

    /* the same key is the same draft; another press is the finding used */
    const replay = await draft(CONTRIBUTOR, contributor.claim.id, key);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(answer);
    const again = await draft(CONTRIBUTOR, contributor.claim.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "FINDING_USED", detail: { use: "DRAFTED", suggestionId: answer.suggestionId } });

    /* the run's view opens the draft's edit page while it is one */
    expect((await viewOf(CONTRIBUTOR, contributor.claim.runId, contributor.claim.id))?.use).toEqual({ state: "DRAFTED", suggestionId: answer.suggestionId, href: `/improve/${answer.suggestionId}/edit`, failure: null });
  });

  it("refuses what the draft door refuses: the throttle 429, another person's finding 404, a run whose text was removed 409, an anchor gone 422 — and changes nothing", async () => {
    engine.throttledUntil = new Date(Date.now() + 86_400_000);
    const throttled = await draft(CONTRIBUTOR, contributor.value.id);
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toMatchObject({ code: "SUGGESTION_THROTTLED" });
    engine.throttledUntil = null;

    expect((await draft(OTHER, contributor.value.id)).status).toBe(404);
    const purged = await draft(CONTRIBUTOR, contributor.purged);
    expect(purged.status).toBe(409);
    expect(await purged.json()).toMatchObject({ code: "FINDING_PURGED" });

    engine.anchorGone = true;
    const gone = await draft(CONTRIBUTOR, contributor.value.id);
    engine.anchorGone = false;
    expect(gone.status).toBe(422);
    expect(await gone.json()).toMatchObject({ code: "ANCHOR_UNKNOWN", detail: { anchor: "F-21-16" } });
    expect(await findingRow(CONTRIBUTOR, contributor.value.id)).toMatchObject({ outcome: "VALID", suggestionId: null });
  });

  it("refuses a draft of a change already proposed, telling the suggestion's id only where it is the contributor's to see — merged, here (48 § 8.5)", async () => {
    const resolved = await resolveAnchor("FIGURE", "F-21-16", "en");
    const rubric = await withSystem(() => getPrisma().rubricVersion.findFirstOrThrow({ where: { appliesAt: { lte: new Date() } }, orderBy: { appliesAt: "desc" }, select: { id: true } }));
    if (resolved === null) throw new Error("F-21-16 is in the release");
    /* another's proposal of the same change, submitted and not merged: not public */
    const created = await withSystem(() => createFromResearch(RESEARCHER, submissionOf(contributor.value.finding, resolved, rubric.id, "EN", new Date()), getPrisma()));
    if (!created.created) throw new Error(`the value's change is already proposed as ${created.duplicateOf}`);
    made.add(created.id);
    const hidden = await draft(CONTRIBUTOR, contributor.value.id);
    expect(hidden.status).toBe(409);
    expect(await hidden.json()).toMatchObject({ code: "PROPOSAL_DUPLICATE", detail: { suggestionId: null } });
    await placeAt(created.id, "MERGED");
    const shown = await draft(CONTRIBUTOR, contributor.value.id);
    expect(await shown.json()).toMatchObject({ code: "PROPOSAL_DUPLICATE", detail: { suggestionId: created.id } });
    expect(await findingRow(CONTRIBUTOR, contributor.value.id)).toMatchObject({ outcome: "VALID" });
    await clearSuggestions([created.id]);
  });

  it("tells a draft whose claim lost a race the finding's use read again, in the view's words — SENT, never the row's SUBMITTED (review of unit 74)", async () => {
    const id = contributor.value.id;
    const raced = researchFindingEndpoints({
      ...DEPS,
      /* a send's step moved the finding between the endpoint's read and the claim */
      claim: async (user, findingId, input) => {
        await withTenant(tenantOf(user), () => getPrisma().researchFinding.updateMany({ where: { id: findingId, outcome: "VALID" }, data: { outcome: "SUBMITTED", sentAt: new Date() } }));
        return DEPS.claim(user, findingId, input);
      },
    });
    const response = await handler(raced.researchFindingDraft, pipeline(CONTRIBUTOR))(new Request(`${BASE}/api/v1/research/findings/${id}/draft`, { method: "POST", headers: { ...HEADERS, "idempotency-key": randomUUID() }, body: JSON.stringify({ locale: "en" }) }), { params: { id } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "FINDING_USED", detail: { use: "SENT", suggestionId: null } });
    /* nothing was made, and the finding goes back as it was for the cases after */
    expect(await findingRow(CONTRIBUTOR, id)).toMatchObject({ outcome: "SUBMITTED", suggestionId: null });
    await withTenant(tenantOf(CONTRIBUTOR), () => getPrisma().researchFinding.updateMany({ where: { id }, data: { outcome: "VALID", sentAt: null } }));
  });

  it("refuses the month's thirty-first send, 429 with the reset, read off the month's counter and not the findings; a send research proposals cannot take here 503; the engine down 503 — the finding unchanged each time (D5, § 8.3)", async () => {
    /* thirty in the counter and not one finding with a sentAt: the counter is what is read (review of unit 74) */
    await setSends(READER, THIS_MONTH, RESEARCH_SENDS_PER_MONTH);
    expect(await withTenant(tenantOf(READER), () => getPrisma().researchFinding.count({ where: { sentAt: { not: null } } }))).toBe(0);
    const limited = await propose(READER, reader.value.id);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "RESEARCH_SENDS_LIMIT", detail: { resetsAt: sendsMonthOf(new Date()).resetsAt.toISOString() } });
    await setSends(READER, THIS_MONTH, null);

    engine.configured = false;
    const unconfigured = await propose(READER, reader.value.id);
    engine.configured = true;
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ code: "RESEARCH_UNAVAILABLE" });

    engine.down = true;
    const down = await propose(READER, reader.value.id);
    engine.down = false;
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ code: "WORKFLOWS_UNAVAILABLE" });
    expect(engine.sends).toEqual([]);
    expect(await findingRow(READER, reader.value.id)).toMatchObject({ outcome: "VALID", suggestionId: null, sentAt: null, failure: null });
  });

  it("ends each send as § 8.4 defines it, the finding left VALID with its code — no principal, no rubric, the anchor gone, its run's text gone, the finding gone — and the next press clears the code", async () => {
    const ref = { findingId: reader.value.id, userId: READER.id };
    expect(await sendStep(ref, { ...SEND, principal: () => false })).toEqual({ sent: "failed", failure: "RESEARCH_UNCONFIGURED" });
    expect((await viewOf(READER, reader.value.runId, reader.value.id))?.use).toEqual({ state: "VALID", suggestionId: null, href: null, failure: "RESEARCH_UNCONFIGURED" });
    expect(await sendStep(ref, { ...SEND, rubricVersion: async () => null })).toEqual({ sent: "failed", failure: "NO_RUBRIC" });
    expect(await sendStep(ref, { ...SEND, anchor: async () => null })).toEqual({ sent: "failed", failure: "ANCHOR_UNKNOWN" });
    expect(await findingRow(READER, reader.value.id)).toMatchObject({ outcome: "VALID", failure: "ANCHOR_UNKNOWN", suggestionId: null });
    expect(await sendStep({ findingId: reader.purged, userId: READER.id }, SEND)).toEqual({ sent: "failed", failure: "TEXT_PURGED" });
    expect(await sendStep({ findingId: randomUUID(), userId: READER.id }, SEND)).toEqual({ sent: "gone" });
    /* another person's finding is gone to the asker's context */
    expect(await sendStep({ findingId: reader.value.id, userId: OTHER.id }, SEND)).toEqual({ sent: "gone" });

    const pressed = await propose(READER, reader.value.id);
    expect(pressed.status).toBe(202);
    expect(await pressed.json()).toEqual({ findingId: reader.value.id, use: "SENDING" });
    expect(await findingRow(READER, reader.value.id)).toMatchObject({ outcome: "VALID", failure: null });
    expect(engine.sends).toEqual([{ findingId: reader.value.id, userId: READER.id }]);
  });

  it("sends a reader's finding: 202 with nothing claimed; the step makes a researcher's proposal with no owner, the finding SUBMITTED with its sentAt; proposed, it is the asker's; the contributor's draft of the same change sees it live", async () => {
    engine.sends = [];
    const pressed = await propose(READER, reader.claim.id);
    expect(pressed.status).toBe(202);
    expect(engine.sends).toEqual([{ findingId: reader.claim.id, userId: READER.id }]);
    expect(await findingRow(READER, reader.claim.id)).toMatchObject({ outcome: "VALID", sentAt: null });

    const ref = { findingId: reader.claim.id, userId: READER.id };
    const sent = await sendStep(ref, SEND);
    if (sent.sent !== "submitted") throw new Error(`the send made ${sent.sent}`);
    made.add(sent.suggestionId);
    const row = await findingRow(READER, reader.claim.id);
    expect(row).toMatchObject({ outcome: "SUBMITTED", suggestionId: sent.suggestionId, failure: null });
    expect(row?.sentAt).toBeInstanceOf(Date);
    /* an earlier attempt's suggestion, answered again for its child */
    expect(await sendStep(ref, SEND)).toEqual(sent);
    const proposal = await withSystem(() => getPrisma().suggestion.findUniqueOrThrow({ where: { id: sent.suggestionId }, select: { origin: true, userId: true, state: true, rationale: true, fromResearch: true, evidence: { select: { kind: true, state: true } } } }));
    expect(proposal).toMatchObject({ origin: "RESEARCHER", userId: null, state: "SUBMITTED", rationale: reader.claim.finding.note, fromResearch: false });
    expect(proposal.evidence).toEqual(reader.claim.finding.sources.map(() => ({ kind: "LINK", state: "PENDING" })));
    expect((await viewOf(READER, reader.claim.runId, reader.claim.id))?.use).toEqual({ state: "SENT", suggestionId: null, href: null, failure: null });
    expect(await outcomeStep(ref, defaultOutcomeStepDeps())).toBe("PENDING");

    /* the contributor's draft of the same change, made before: the sent proposal is live at its key, and not theirs to see */
    const draftKey = (await withTenant(tenantOf(CONTRIBUTOR), () => getPrisma().researchFinding.findMany({ where: { outcome: "DRAFTED" }, select: { suggestionId: true } })))[0]?.suggestionId ?? null;
    const draftRow = draftKey === null ? null : await withSystem(() => getPrisma().suggestion.findUnique({ where: { id: draftKey }, select: { proposalKey: true } }));
    expect(draftRow?.proposalKey).toBeTruthy();
    expect(await withSystem(() => liveSuggestionWithKey(callerOf(CONTRIBUTOR), draftRow?.proposalKey ?? ""))).toBe(sent.suggestionId);
    expect(await withSystem(() => duplicateVisibleTo(CONTRIBUTOR, sent.suggestionId))).toBe(false);

    /* placed in the queue: proposed, the asker's — Add my name's check, Improve's list, the run's panel */
    await placeAt(sent.suggestionId, "CURATOR_QUEUE");
    expect(await askerOfProposal(READER, sent.suggestionId)).toBe(false);
    expect(await outcomeStep(ref, defaultOutcomeStepDeps())).toBe("PROPOSED");
    expect(await askerOfProposal(READER, sent.suggestionId)).toBe(true);
    expect((await readProposalsOfAsker(READER)).map((view) => view.suggestionId)).toContain(sent.suggestionId);
    const view = await viewOf(READER, reader.claim.runId, reader.claim.id);
    expect(view?.use).toEqual({ state: "PROPOSED", suggestionId: sent.suggestionId, href: null, failure: null });
    expect(view?.proposal?.suggestionId).toBe(sent.suggestionId);
    const again = await propose(READER, reader.claim.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "FINDING_USED", detail: { use: "PROPOSED", suggestionId: sent.suggestionId } });
  });

  it("reads a refuted send as `sent · not proposed` with no id (D3), and deletes a refuted finding a delete detached", async () => {
    const ref = { findingId: reader.value.id, userId: READER.id };
    const sent = await sendStep(ref, SEND);
    if (sent.sent !== "submitted") throw new Error(`the send made ${sent.sent}`);
    made.add(sent.suggestionId);
    await placeAt(sent.suggestionId, "CLOSED");
    expect(await outcomeStep(ref, defaultOutcomeStepDeps())).toBe("REFUTED");
    expect((await viewOf(READER, reader.value.runId, reader.value.id))?.use).toEqual({ state: "REFUTED", suggestionId: null, href: null, failure: null });
    expect(await askerOfProposal(READER, sent.suggestionId)).toBe(false);

    /* a sent finding its research's delete detached, refuted: no proposal of the asker's to keep */
    const detached = await withTenant(tenantOf(READER), () => getPrisma().researchFinding.create({ data: { runId: null, userId: READER.id, ordinal: 1, outcome: "SUBMITTED", suggestionId: sent.suggestionId, sentAt: new Date() }, select: { id: true } }));
    expect(await outcomeStep({ findingId: detached.id, userId: READER.id }, defaultOutcomeStepDeps())).toBe("REFUTED");
    expect(await findingRow(READER, detached.id)).toBeNull();
    /* the two the suite sent are still the month's two: the delete gave no place back (review of unit 74) */
    expect(await sendsOf(READER, THIS_MONTH)).toBe(2);
  });

  it("sends a change already proposed as a duplicate, which names nothing it made and no sentAt; its id shown only where the asker may see it", async () => {
    /* the contributor's value is the same change as the reader's, now closed: a duplicate, not the asker's to be told */
    const ref = { findingId: contributor.value.id, userId: CONTRIBUTOR.id };
    const sent = await sendStep(ref, SEND);
    expect(sent.sent).toBe("duplicate");
    expect(await findingRow(CONTRIBUTOR, contributor.value.id)).toMatchObject({ outcome: "DUPLICATE", sentAt: null });
    expect((await viewOf(CONTRIBUTOR, contributor.value.runId, contributor.value.id))?.use).toEqual({ state: "DUPLICATE", suggestionId: null, href: null, failure: null });
    /* it made nothing, so it took no place in the month's thirty */
    expect(await sendsOf(CONTRIBUTOR, THIS_MONTH)).toBeNull();
  });

  describe("the month's thirty as a counter no delete reaches (48 § 8.3, D5; review of unit 74)", () => {
    /** The sender's bare findings, VALID, each read by the send as the reader's claim on 21.3 and made under a key of its own, so none doubles another unless it is told to. */
    const keys = new Map<string, string>();
    const keyOf = (label: string): string => createHash("sha256").update(`research-findings:${label}`).digest("hex");
    const SENDING: SendStepDeps = {
      ...SEND,
      read: async (ref) => {
        const row = await readFindingToSend(ref);
        return row === null ? null : { ...row, locale: "EN", text: { kind: "held", finding: reader.claim.finding } };
      },
      send: (ref, at, input) => sendFindingTx(ref, at, (client) => createFromResearch(RESEARCHER, { ...input, proposalKey: keys.get(ref.findingId) ?? keyOf(ref.findingId) }, client)),
    };
    const bareFindings = (count: number, from: number) => withTenant(tenantOf(SENDER), async () => Promise.all(Array.from({ length: count }, (_, index) => getPrisma().researchFinding.create({ data: { runId: null, userId: SENDER.id, ordinal: from + index, outcome: "VALID" }, select: { id: true } }).then((row) => row.id))));
    const refOf = (findingId: string): FindingRef => ({ findingId, userId: SENDER.id });
    const madeWith = (label: string) => withSystem(() => getPrisma().suggestion.findMany({ where: { proposalKey: keyOf(label) }, select: { id: true } }));

    it("at twenty-nine takes no place for a duplicate; then of four presses at once exactly one makes a suggestion and the rest end SENDS_LIMIT, rolled back with nothing made", async () => {
      const at = new Date();
      const month = sendsMonthOf(at).month;
      await setSends(SENDER, month, RESEARCH_SENDS_PER_MONTH - 1);
      const [doubled, ...burst] = await bareFindings(5, 1);
      if (doubled === undefined) throw new Error("five findings were made");

      /* a duplicate at twenty-nine: the same change already proposed, so nothing made and no place taken */
      const resolved = await resolveAnchor("SECTION", "21.3", "en");
      const rubric = await withSystem(() => getPrisma().rubricVersion.findFirstOrThrow({ where: { appliesAt: { lte: new Date() } }, orderBy: { appliesAt: "desc" }, select: { id: true } }));
      if (resolved === null) throw new Error("21.3 is in the release");
      const first = await withSystem(() => createFromResearch(RESEARCHER, { ...submissionOf(reader.claim.finding, resolved, rubric.id, "EN", at), proposalKey: keyOf("doubled") }, getPrisma()));
      if (!first.created) throw new Error("the doubled change is new");
      made.add(first.id);
      keys.set(doubled, keyOf("doubled"));
      expect(await sendStep(refOf(doubled), { ...SENDING, now: () => at })).toEqual({ sent: "duplicate", suggestionId: first.id });
      expect(await sendsOf(SENDER, month)).toBe(RESEARCH_SENDS_PER_MONTH - 1);

      /* four presses at once at twenty-nine, each a change of its own */
      burst.forEach((id, index) => keys.set(id, keyOf(`burst:${String(index)}`)));
      const ends = await Promise.all(burst.map((id) => sendStep(refOf(id), { ...SENDING, now: () => at })));
      const submitted = ends.flatMap((end) => (end.sent === "submitted" ? [end.suggestionId] : []));
      for (const id of submitted) made.add(id);
      expect(submitted).toHaveLength(1);
      expect(ends.filter((end) => end.sent === "failed" && end.failure === "SENDS_LIMIT")).toHaveLength(burst.length - 1);
      expect(await sendsOf(SENDER, month)).toBe(RESEARCH_SENDS_PER_MONTH);

      /* the rest made nothing: each still VALID with the code, no sentAt, and no suggestion under its key */
      const madeUnderBurst = (await Promise.all(burst.map((_, index) => madeWith(`burst:${String(index)}`)))).flat();
      expect(madeUnderBurst.map((row) => row.id)).toEqual(submitted);
      for (const [index, id] of burst.entries()) {
        const row = await findingRow(SENDER, id);
        if (ends[index]?.sent === "submitted") expect(row).toMatchObject({ outcome: "SUBMITTED", suggestionId: submitted[0], failure: null });
        else expect(row).toMatchObject({ outcome: "VALID", suggestionId: null, failure: "SENDS_LIMIT", sentAt: null });
      }
      /* the endpoint's fast check reads the same counter */
      expect(await defaultResearchFindingEndpointDeps.sentIn(SENDER, month)).toBe(RESEARCH_SENDS_PER_MONTH);
    });

    it("rolls the month over in UTC: at thirty, a send late on the 31st in São Paulo is the next month's first", async () => {
      await setSends(SENDER, "2031-01", RESEARCH_SENDS_PER_MONTH);
      const [late] = await bareFindings(1, 10);
      if (late === undefined) throw new Error("a finding was made");
      keys.set(late, keyOf("rollover"));
      /* 20:59 on 31 January in São Paulo is still January in UTC: the thirty are taken */
      expect(await sendStep(refOf(late), { ...SENDING, now: () => new Date("2031-01-31T20:59:00.000-03:00") })).toEqual({ sent: "failed", failure: "SENDS_LIMIT" });
      expect(await sendsOf(SENDER, "2031-02")).toBeNull();
      /* 21:30 there is February in UTC: a new month's row, its first send */
      const sent = await sendStep(refOf(late), { ...SENDING, now: () => new Date("2031-01-31T21:30:00.000-03:00") });
      if (sent.sent !== "submitted") throw new Error(`the send made ${sent.sent}`);
      made.add(sent.suggestionId);
      expect(await sendsOf(SENDER, "2031-02")).toBe(1);
      expect(await sendsOf(SENDER, "2031-01")).toBe(RESEARCH_SENDS_PER_MONTH);
      expect(await findingRow(SENDER, late)).toMatchObject({ outcome: "SUBMITTED", sentAt: new Date("2031-02-01T00:30:00.000Z"), failure: null });
    });

    it("keeps the month's sends when the person deletes their research and the sweep takes its runs and its refuted finding", async () => {
      /* the reader's claim, proposed, and value, refuted, were this month's two */
      expect(await sendsOf(READER, THIS_MONTH)).toBe(2);
      expect(await deleteResearchConversation(READER, reader.seed.done)).toMatchObject({ deleted: true });
      const swept = await sweepDetachedRuns({ now: new Date(Date.now() + 2 * DETACHED_RUN_KEPT_MS), running: async () => false, reader: READER.id });
      expect(swept.engineAnswered).toBe(true);
      /* what the findings would now say: the proposed one kept as the asker's, the refuted one gone with its run */
      expect(await findingRow(READER, reader.claim.id)).toMatchObject({ outcome: "PROPOSED", runId: null });
      expect(await findingRow(READER, reader.value.id)).toBeNull();
      expect(await withTenant(tenantOf(READER), () => getPrisma().researchFinding.count({ where: { sentAt: { gte: sendsMonthOf(new Date()).since } } }))).toBe(1);
      /* the counter is no finding's: still two, as the endpoint reads it */
      expect(await sendsOf(READER, THIS_MONTH)).toBe(2);
      expect(await defaultResearchFindingEndpointDeps.sentIn(READER, THIS_MONTH)).toBe(2);
    });
  });
});
