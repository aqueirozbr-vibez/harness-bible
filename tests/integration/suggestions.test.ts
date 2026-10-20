import { randomUUID } from "node:crypto";

import { Client, Connection } from "@temporalio/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as authDev } from "@/app/api/v1/auth/dev/route";
import { DELETE as deleteRoute, GET as readRoute, PATCH as patchRoute } from "@/app/api/v1/suggestions/[id]/route";
import { POST as submitRoute } from "@/app/api/v1/suggestions/[id]/submit/route";
import { POST as suggestionsRoute } from "@/app/api/v1/suggestions/route";
import { resolveDevUser } from "@/lib/auth/link";
import { getPrisma } from "@/lib/db/client";
import { setRosterEntry } from "@/lib/db/improve";
import { view } from "@/lib/db/ledger";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { loadRubric } from "@/lib/rubrics/load";
import { SuggestionCreatedSchema, SuggestionSubmittedSchema, SuggestionViewSchema } from "@/lib/schemas/suggestions";
import { SUGGESTION_WAITS_QUERY, SuggestionWaitsSchema } from "@/lib/schemas/workflows";
import { sha256 } from "@/pipeline/renderHash";
import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";

/*
 * The suggestion endpoints against the database and the policy sidecar (feature-specs/31 § 3, § 4, § 7, § 10).
 * POST: a verified contributor's drafts on a section, a derived figure, a scenario parameter and a source row of
 * the pinned release, with the classes and thresholds of 31 § 10.2; the same key answering the same draft; a
 * reader, an unverified contributor and a throttled contributor refused as § 7 says. PATCH, GET and DELETE: the
 * proposal written and the class recomputed on the PATCH that adds it, the owner's read, a curator of the part's
 * 404 on a draft, the draft deleted. SUBMIT, against the real engine: the consent, the sensors with the three cases
 * § 10.3 names, the workflow started under the suggestion's id and run by the workers through steps 1 to 4 of spec
 * 33 § 3 (unit 50a: the submitted and graded records, the route), the row submitted, the running workflow for a
 * second key. And no model called by any of it (§ 10.8: the gateway's ledger gains no row).
 *
 * The workflow's records stay in the ledger, as every record does, about suggestions the suite then removes; and
 * since the workers append them while the suite runs, it holds `LEDGER_LOCK` (tests/fixtures/exclusive.ts), so
 * that a suite asserting the chain's head does not see them arrive.
 *
 * The suite's accounts and their drafts are its own and are removed after. A submitted suggestion is a record and
 * the database refuses to delete one, so the suite puts its own back to draft first, by name, which nothing of the
 * product does; its workflows stay in the engine's history as the proving ones do.
 */

const ready = env.DATABASE_URL !== undefined && env.OPA_URL !== undefined && env.AUTH_DEV_PROVIDER === "1";
const engine = ready && env.TEMPORAL_ADDRESS !== undefined && env.TEMPORAL_NAMESPACE !== undefined;

const CONTRIBUTOR = "suggestions-contributor@harness-bible.local";
const UNVERIFIED = "suggestions-unverified@harness-bible.local";
const READER = "suggestions-reader@harness-bible.local";
const CURATOR = "suggestions-curator@harness-bible.local";
const EMAILS = [CONTRIBUTOR, UNVERIFIED, READER, CURATOR];
const ADDRESS = `2001:db8:2::${Date.now().toString(16)}`;
const base = env.APP_URL.replace(/\/$/, "");

const tokens: Record<string, string> = {};

async function signIn(email: string, role: "READER" | "CONTRIBUTOR" | "CURATOR", verified: boolean): Promise<string> {
  const response = await authDev(new Request(`${base}/api/v1/auth/dev?email=${encodeURIComponent(email)}&role=${role}&verified=${String(verified)}&next=/en`, { headers: { "x-forwarded-for": ADDRESS } }), { params: Promise.resolve({}) });
  expect(response.status).toBe(302);
  return /hb\.session=([^;]+)/.exec(response.headers.getSetCookie().join("\n"))?.[1] ?? "";
}

function post(token: string, body: unknown, key: string = randomUUID()): Promise<Response> {
  return suggestionsRoute(
    new Request(`${base}/api/v1/suggestions`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": ADDRESS, cookie: `hb.session=${token}`, "idempotency-key": key },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

const headersOf = (token: string): Record<string, string> => ({ "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": ADDRESS, cookie: `hb.session=${token}` });
const read = (token: string, id: string): Promise<Response> => readRoute(new Request(`${base}/api/v1/suggestions/${id}`, { headers: headersOf(token) }), { params: Promise.resolve({ id }) });
const patch = (token: string, id: string, body: unknown): Promise<Response> => patchRoute(new Request(`${base}/api/v1/suggestions/${id}`, { method: "PATCH", headers: headersOf(token), body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const remove = (token: string, id: string): Promise<Response> => deleteRoute(new Request(`${base}/api/v1/suggestions/${id}`, { method: "DELETE", headers: headersOf(token) }), { params: Promise.resolve({ id }) });
const submit = (token: string, id: string, consent: boolean, key: string = randomUUID()): Promise<Response> =>
  submitRoute(new Request(`${base}/api/v1/suggestions/${id}/submit`, { method: "POST", headers: { ...headersOf(token), "idempotency-key": key }, body: JSON.stringify({ consent }) }), { params: Promise.resolve({ id }) });

/** A draft of the contributor's that every sensor passes: a text edit of 21.3 with one graded item and a rationale; a wording change unless `after` makes it another. */
async function readyDraft(token: string, after = "Retries are required at eleven steps."): Promise<string> {
  const created = (await (await post(token, { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en" })).json()) as { id: string };
  const patched = await patch(token, created.id, { proposal: { kind: "EDIT_TEXT", before: "Retries are not optional at eleven steps.", after }, rationale: "integration suite: the sentence reads better as a requirement." });
  expect(patched.status).toBe(200);
  /* An evidence item as the grader's activities leave it (unit 49e): graded, with its factors and its reason, which the workflow's graded record hashes; written as a row so that no model is asked. */
  await withSystem(() => getPrisma().evidenceItem.create({ data: { suggestionId: created.id, ordinal: 1, kind: "LINK", state: "GRADED", url: "https://provider-two.example/pricing", host: "provider-two.example", fetchStatus: "opened:200", tier: "C", baseScore: 70, relevance: 1, recency: 1, independence: 0.8, adjustedScore: 56, reason: "the vendor's own pricing page states the figure", gradedBy: "integration-suite" } }));
  return created.id;
}

const userIds = async (): Promise<string[]> => withSystem(async () => (await getPrisma().user.findMany({ where: { email: { in: EMAILS } }, select: { id: true } })).map((user) => user.id));
/** The gateway's ledger rows of the suite's accounts: the budget ledger is a person's rows, read as each person. */
async function gatewayRows(): Promise<number> {
  let rows = 0;
  for (const userId of await userIds()) rows += await withTenant({ userId, organisationId: null }, () => getPrisma().budgetLedger.count({ where: { userId } }));
  return rows;
}

async function cleanup(): Promise<void> {
  await withSystem(async () => {
    const prisma = getPrisma();
    const ids = await userIds();
    /* The suite's submitted suggestions back to draft, so that the row can go: a move nothing of the product makes. */
    await prisma.suggestion.updateMany({ where: { userId: { in: ids }, state: { not: "DRAFT" } }, data: { state: "DRAFT", submittedAt: null, workflowId: null } });
    await prisma.suggestion.deleteMany({ where: { userId: { in: ids }, state: "DRAFT" } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.authEvent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
}

describe.skipIf(!ready)("POST /api/v1/suggestions, against the database and the sidecar", () => {
  let gatewayBefore = 0;
  let release: () => void = () => undefined;

  beforeAll(async () => {
    release = await acquire(LEDGER_LOCK);
    await cleanup();
    tokens.contributor = await signIn(CONTRIBUTOR, "CONTRIBUTOR", true);
    tokens.unverified = await signIn(UNVERIFIED, "CONTRIBUTOR", false);
    tokens.reader = await signIn(READER, "READER", true);
    tokens.curator = await signIn(CURATOR, "CURATOR", true);
    /* The curator of chapter 21's part: a draft there is never theirs to read, a submitted suggestion there would be. */
    const chapter = await withSystem(() => getPrisma().chapter.findUniqueOrThrow({ where: { number: 21 }, select: { part: true } }));
    const curator = await resolveDevUser(CURATOR, "en");
    await withSystem(() => setRosterEntry({ userId: curator.userId, part: chapter.part, until: null }));
    gatewayBefore = await gatewayRows();
  }, 360_000);

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      release();
    }
  });

  it("a draft on 21.3 with EDIT_TEXT is WORDING with 40 and 5, anchored to the section's source text and its hash, with the rubric in force", async () => {
    const response = await post(tokens.contributor ?? "", { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en" });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const body = SuggestionCreatedSchema.parse(JSON.parse(text));
    expect(body).toMatchObject({ state: "DRAFT", changeKind: "EDIT_TEXT", changeClass: "WORDING", curatorReason: null, thresholds: { acceptAt: 40, floorAt: 5 }, fastMoving: false, rubricVersion: loadRubric("v1.2").rubric.version });
    expect(body.id).toMatch(/^S-21-\d{4,}$/);
    expect(body.anchor).toMatchObject({ kind: "SECTION", id: "21.3", section: "21.3", tier: null, readBy: [] });
    expect(body.anchor.currentText.length).toBeGreaterThan(100);

    const row = await withSystem(() => getPrisma().suggestion.findUnique({ where: { id: body.id }, select: { state: true, parts: true, chapterNumber: true, rubricVersionId: true, locale: true, anchor: { select: { sectionAnchor: true, contentSha256: true, existsAtVersion: true } } } }));
    expect(row).toMatchObject({ state: "DRAFT", chapterNumber: 21, rubricVersionId: "v1.2", locale: "EN", anchor: { sectionAnchor: "21.3", contentSha256: sha256(body.anchor.currentText), existsAtVersion: true } });
    expect(row?.parts.length).toBeGreaterThanOrEqual(1);
  });

  it("a value set on a derived figure is DERIVED_FIGURE with 100 and 100; on a scenario parameter, CURATOR_ALWAYS · SCENARIO_PARAMETER", async () => {
    const derived = await post(tokens.contributor ?? "", { anchor: { kind: "FIGURE", id: "F-01-19" }, changeKind: "SET_VALUE", locale: "en" });
    expect(derived.status).toBe(200);
    expect(await derived.json()).toMatchObject({ changeClass: "DERIVED_FIGURE", curatorReason: null, thresholds: { acceptAt: 100, floorAt: 100 }, anchor: { kind: "FIGURE", id: "F-01-19", section: "01.2", tier: "DERIVED" } });

    const scenario = await post(tokens.contributor ?? "", { anchor: { kind: "FIGURE", id: "F-01-44" }, changeKind: "SET_VALUE", locale: "pt" });
    expect(scenario.status).toBe(200);
    expect(await scenario.json()).toMatchObject({ changeClass: "CURATOR_ALWAYS", curatorReason: "SCENARIO_PARAMETER", thresholds: { acceptAt: null, floorAt: null } });
  });

  it("a row edited is CITED_FIGURE with 70 and 25, read by the sections of the figures that read it", async () => {
    const response = await post(tokens.contributor ?? "", { anchor: { kind: "SOURCE_ROW", id: "21.9 r1" }, changeKind: "EDIT_ROW", locale: "en" });
    expect(response.status).toBe(200);
    const body = SuggestionCreatedSchema.parse(await response.json());
    expect(body).toMatchObject({ changeClass: "CITED_FIGURE", thresholds: { acceptAt: 70, floorAt: 25 }, anchor: { kind: "SOURCE_ROW", id: "21.9 r1", section: "21.9", tier: "VENDOR" } });
    expect(body.anchor.verifiedOn).not.toBeNull();
    for (const entry of body.anchor.readBy) expect(entry.section, entry.title).toMatch(/^\d{2}\.[1-9]$/);
  });

  it("the same Idempotency-Key answers the same draft; a new key is a new draft with the chapter's next serial", async () => {
    const key = randomUUID();
    const body = { anchor: { kind: "SECTION", id: "21.4" }, changeKind: "ADD_CLAIM", locale: "en" };
    const first = await post(tokens.contributor ?? "", body, key);
    const again = await post(tokens.contributor ?? "", body, key);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    const [a, b] = [(await first.json()) as { id: string }, (await again.json()) as { id: string }];
    expect(b.id).toBe(a.id);
    const next = (await (await post(tokens.contributor ?? "", body)).json()) as { id: string };
    /* a later serial of the chapter's, not necessarily the very next: other suites draft in chapter 21 while this one runs */
    expect(next.id).not.toBe(a.id);
    expect(Number(next.id.slice(5))).toBeGreaterThan(Number(a.id.slice(5)));
  });

  it("refuses what 31 § 3 names, in the API's error form, and writes nothing for it", async () => {
    /* The suite's own accounts' suggestions: other suites make chapter 21's drafts while this one runs. */
    const ours = { chapterNumber: 21, userId: { in: await userIds() } };
    const before = await withSystem(() => getPrisma().suggestion.count({ where: ours }));
    const noAnchor = await post(tokens.contributor ?? "", { changeKind: "EDIT_TEXT", locale: "en" });
    expect(noAnchor.status).toBe(422);
    expect(await noAnchor.json()).toMatchObject({ code: "ANCHOR_REQUIRED" });
    const unknown = await post(tokens.contributor ?? "", { anchor: { kind: "SECTION", id: "99.9" }, changeKind: "EDIT_TEXT", locale: "en" });
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({ code: "ANCHOR_UNKNOWN", detail: { release: "2026.09" } });
    const malformed = await post(tokens.contributor ?? "", { anchor: { kind: "FIGURE", id: "21.3" }, changeKind: "SET_VALUE", locale: "en" });
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toMatchObject({ code: "ANCHOR_UNKNOWN" });
    const pairing = await post(tokens.contributor ?? "", { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "SET_VALUE", locale: "en" });
    expect(pairing.status).toBe(422);
    expect(await pairing.json()).toMatchObject({ code: "CHANGE_KIND_INVALID", detail: { allowed: "FIGURE" } });
    expect(await withSystem(() => getPrisma().suggestion.count({ where: ours }))).toBe(before);
  });

  it("refuses a reader by role, an unverified contributor by the policy, and a throttled contributor until the date (§ 7)", async () => {
    const body = { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en" };
    const reader = await post(tokens.reader ?? "", body);
    expect(reader.status).toBe(403);
    expect(await reader.json()).toMatchObject({ code: "ROLE_REQUIRED" });
    const unverified = await post(tokens.unverified ?? "", body);
    expect(unverified.status).toBe(403);
    expect(await unverified.json()).toMatchObject({ code: "FORBIDDEN" });

    const tomorrow = new Date(Date.now() + 86_400_000);
    const contributor = await resolveDevUser(CONTRIBUTOR, "en");
    await withSystem(() => getPrisma().user.update({ where: { id: contributor.userId }, data: { throttledUntil: tomorrow } }));
    try {
      const throttled = await post(tokens.contributor ?? "", body);
      expect(throttled.status).toBe(429);
      expect(await throttled.json()).toMatchObject({ code: "SUGGESTION_THROTTLED", detail: { throttledUntil: tomorrow.toISOString(), reason: "3 declines for unverifiable evidence in 30 days" } });
    } finally {
      await withSystem(() => getPrisma().user.update({ where: { id: contributor.userId }, data: { throttledUntil: null } }));
    }
    expect((await post(tokens.contributor ?? "", body)).status).toBe(200);
  });

  it("PATCH writes the proposal and recomputes the class on the change that adds it: a text edit is WORDING, and the curator's once its text trips the control-system vocabulary (§ 10.2)", async () => {
    const created = (await (await post(tokens.contributor ?? "", { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en" })).json()) as { id: string; anchor: { contentSha256?: string } };
    const plain = await patch(tokens.contributor ?? "", created.id, { proposal: { kind: "EDIT_TEXT", before: "three times", after: "four times" }, rationale: "The cap was raised in 2026.09." });
    expect(plain.status).toBe(200);
    const plainBody = await plain.json();
    expect(plainBody).toMatchObject({ id: created.id, own: true, state: "DRAFT", changeClass: "WORDING", thresholds: { acceptAt: 40, floorAt: 5 }, proposal: { kind: "EDIT_TEXT", before: "three times", after: "four times" }, rationale: "The cap was raised in 2026.09." });

    const ot = await patch(tokens.contributor ?? "", created.id, { proposal: { kind: "EDIT_TEXT", before: "three times", after: "When the historian lags, write the setpoint to the PLC directly." } });
    expect(ot.status).toBe(200);
    expect(await ot.json()).toMatchObject({ changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT", thresholds: { acceptAt: null, floorAt: null }, rationale: "The cap was raised in 2026.09." });
    const row = await withSystem(() => getPrisma().suggestion.findUnique({ where: { id: created.id }, select: { changeClass: true, curatorReason: true, proposalKey: true, proposal: true } }));
    expect(row).toMatchObject({ changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT", proposal: { kind: "EDIT_TEXT" } });
    expect(row?.proposalKey).toMatch(/^[0-9a-f]{64}$/);

    /* Idempotent by content: the same patch twice is the same suggestion, no key asked for. */
    const again = await patch(tokens.contributor ?? "", created.id, { proposal: { kind: "EDIT_TEXT", before: "three times", after: "four times" } });
    const once = await again.json();
    const twice = await (await patch(tokens.contributor ?? "", created.id, { proposal: { kind: "EDIT_TEXT", before: "three times", after: "four times" } })).json();
    expect(twice).toEqual(once);
    expect(once).toMatchObject({ changeClass: "WORDING" });
  });

  it("PATCH scores a graded item again when a claim's fast-moving declaration moves its recency, in the row and in the answer, and back when it is unticked (30 § 3.4; 34 § 24)", async () => {
    const created = (await (await post(tokens.contributor ?? "", { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM", locale: "en" })).json()) as { id: string };
    const claim = { kind: "ADD_CLAIM", text: "Provider tier 3 cut its batch price in 2023.", placeAfter: "end" } as const;
    expect((await patch(tokens.contributor ?? "", created.id, { proposal: { ...claim, fastMoving: false } })).status).toBe(200);
    /* Graded while the claim was stable, three years old: recency 1.0. Written as a row, so that no model is asked. */
    const item = await withSystem(() => getPrisma().evidenceItem.create({ data: { suggestionId: created.id, ordinal: 1, kind: "LINK", state: "GRADED", url: "https://journal.example/paper", host: "journal.example", fetchStatus: "opened:200", tier: "B", baseScore: 85, relevance: 1, recency: 1, independence: 1, adjustedScore: 85, ageDays: 1100, reason: "a peer-reviewed paper states the figure", gradedBy: "integration-suite" } }));
    const stored = async () => withSystem(() => getPrisma().evidenceItem.findUniqueOrThrow({ where: { id: item.id }, select: { recency: true, adjustedScore: true } }));

    const ticked = SuggestionViewSchema.parse(await (await patch(tokens.contributor ?? "", created.id, { proposal: { ...claim, fastMoving: true } })).json());
    expect(ticked).toMatchObject({ fastMoving: true, evidence: [{ id: item.id, recency: 0.3, adjustedScore: 25 }] });
    expect(await stored()).toMatchObject({ adjustedScore: 25 });
    expect(Number((await stored()).recency)).toBe(0.3);

    const unticked = SuggestionViewSchema.parse(await (await patch(tokens.contributor ?? "", created.id, { proposal: { ...claim, fastMoving: false } })).json());
    expect(unticked).toMatchObject({ fastMoving: false, evidence: [{ id: item.id, recency: 1, adjustedScore: 85 }] });
    expect(await stored()).toMatchObject({ adjustedScore: 85 });
  });

  it("GET is the owner's draft with its proposal; a curator of its part gets 404 on a draft, as does another contributor and a reader (§ 7)", async () => {
    const created = (await (await post(tokens.contributor ?? "", { anchor: { kind: "SOURCE_ROW", id: "21.9 r1" }, changeKind: "EDIT_ROW", locale: "pt" })).json()) as { id: string };
    await patch(tokens.contributor ?? "", created.id, { proposal: { kind: "EDIT_ROW", citation: "Vendor docs, 2026-09" } });
    const own = await read(tokens.contributor ?? "", created.id);
    expect(own.status).toBe(200);
    const body = SuggestionViewSchema.parse(await own.json());
    expect(body).toMatchObject({ id: created.id, own: true, locale: "pt", chapter: 21, changeClass: "CITED_FIGURE", thresholds: { acceptAt: 70, floorAt: 25 }, proposal: { kind: "EDIT_ROW", citation: "Vendor docs, 2026-09" }, anchor: { kind: "SOURCE_ROW", id: "21.9 r1", section: "21.9" } });
    for (const [who, token] of [["curator", tokens.curator], ["unverified", tokens.unverified], ["reader", tokens.reader]] as const) {
      const response = await read(token ?? "", created.id);
      expect(response.status, who).toBe(404);
      expect(await response.json(), who).toMatchObject({ code: "NOT_FOUND" });
    }
    expect((await read(tokens.contributor ?? "", "S-21-9999")).status).toBe(404);
    expect((await read(tokens.contributor ?? "", "nonsense")).status).toBe(400);
  });

  it("DELETE removes the owner's draft with its anchor; then it is gone, and another's is never theirs to delete", async () => {
    const created = (await (await post(tokens.contributor ?? "", { anchor: { kind: "SECTION", id: "21.5" }, changeKind: "RESTRUCTURE", locale: "en" })).json()) as { id: string };
    expect((await remove(tokens.unverified ?? "", created.id)).status).toBe(404);
    const deleted = await remove(tokens.contributor ?? "", created.id);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id: created.id, deleted: true });
    expect((await read(tokens.contributor ?? "", created.id)).status).toBe(404);
    expect((await remove(tokens.contributor ?? "", created.id)).status).toBe(404);
    expect(await withSystem(() => getPrisma().anchor.count({ where: { suggestionId: created.id } }))).toBe(0);
  });

  it("SUBMIT is refused by the sensors it names, with nothing started: a 201-word rationale, an anchor that is not at the current version, no evidence (§ 10.3)", async () => {
    const token = tokens.contributor ?? "";
    const id = await readyDraft(token);
    await patch(token, id, { rationale: Array.from({ length: 201 }, (_, index) => `w${String(index)}`).join(" ") });
    const rationale = await submit(token, id, true);
    expect(rationale.status).toBe(422);
    expect(await rationale.json()).toMatchObject({ code: "INTAKE_RATIONALE_LENGTH", detail: { sensor: "RATIONALE_LENGTH", data: { words: 201 } } });
    await patch(token, id, { rationale: "integration suite: the sentence reads better as a requirement." });

    await withSystem(() => getPrisma().anchor.update({ where: { suggestionId: id }, data: { contentSha256: "f".repeat(64) } }));
    const moved = await submit(token, id, true);
    expect(moved.status).toBe(422);
    const body = (await moved.json()) as { code: string; detail: { detail: string; data: { was: string; now: string } } };
    expect(body).toMatchObject({ code: "INTAKE_ANCHOR_EXISTS", detail: { sensor: "ANCHOR_EXISTS" } });
    expect(body.detail.detail).toMatch(/^21\.3 changed since the draft at ch21 v/);
    expect(body.detail.data.now.length).toBeGreaterThan(100);

    const bare = (await (await post(token, { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en" })).json()) as { id: string };
    await patch(token, bare.id, { proposal: { kind: "EDIT_TEXT", before: "Retries are not optional at eleven steps.", after: "Retries are required at eleven steps." }, rationale: "integration suite." });
    const evidence = await submit(token, bare.id, true);
    expect(evidence.status).toBe(422);
    expect(await evidence.json()).toMatchObject({ code: "INTAKE_EVIDENCE_PARSES", detail: { sensor: "EVIDENCE_PARSES", data: { items: 0 } } });

    for (const suggestion of [id, bare.id]) expect(await withSystem(() => getPrisma().suggestion.findUnique({ where: { id: suggestion }, select: { state: true, workflowId: true } }))).toEqual({ state: "DRAFT", workflowId: null });
  });

  it("SUBMIT asks for consent once, then starts the workflow under the suggestion's id, moves the row, and answers the running workflow to a second key (§ 6, § 10.4)", { timeout: 60_000 }, async () => {
    if (!engine) return;
    const token = tokens.contributor ?? "";
    /* A safety change, which only a curator decides: the development workers call the real gateway, and since unit 50d an adjudicator's route would be a frontier call (§ 10.8). */
    const id = await readyDraft(token, "When the historian lags, write the setpoint to the PLC directly.");
    const contributor = await resolveDevUser(CONTRIBUTOR, "en");
    expect((await withSystem(() => getPrisma().user.findUniqueOrThrow({ where: { id: contributor.userId }, select: { provenanceConsentAt: true } }))).provenanceConsentAt).toBeNull();

    const refused = await submit(token, id, false);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "CONSENT_REQUIRED" });

    const submitted = await submit(token, id, true);
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const body = SuggestionSubmittedSchema.parse(await submitted.json());
    expect(body).toEqual({ id, state: "SUBMITTED", workflowId: `suggestion:${id}` });
    /* The workers may already have decided it, so its state is read once the run has ended. */
    const row = await withSystem(() => getPrisma().suggestion.findUniqueOrThrow({ where: { id }, select: { workflowId: true, submittedAt: true } }));
    expect(row).toMatchObject({ workflowId: `suggestion:${id}` });
    expect(row.submittedAt).not.toBeNull();
    expect((await withSystem(() => getPrisma().user.findUniqueOrThrow({ where: { id: contributor.userId }, select: { provenanceConsentAt: true } }))).provenanceConsentAt).not.toBeNull();

    /* The workers run it through steps 1 to 6 and record the decision (units 50a to 50e): its one item graded C at 56, the consistency sensors, a curator-always change sent to the queue with no model asked, where the run waits for a curator — and is ended here, so that no run of the suite is left waiting. */
    const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS ?? "" });
    try {
      const handle = new Client({ connection, namespace: env.TEMPORAL_NAMESPACE ?? "" }).workflow.getHandle(`suggestion:${id}`);
      let waits = null;
      for (let tries = 0; tries < 300 && waits === null; tries += 1) {
        waits = SuggestionWaitsSchema.parse(await handle.query(SUGGESTION_WAITS_QUERY));
        if (waits === null) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(waits).toEqual({ curator: true, revision: false });
      await handle.terminate("the suggestions suite has what it needs");
    } finally {
      await connection.close();
    }
    expect(await withSystem(() => getPrisma().suggestion.findUniqueOrThrow({ where: { id }, select: { state: true, outcome: true } }))).toEqual({ state: "CURATOR_QUEUE", outcome: "CURATOR_REVIEW" });
    expect((await view({ suggestionId: id })).map((record) => [record.kind, record.actor])).toEqual([
      ["SUBMITTED", `user:${contributor.userId}`],
      ["GRADED", "service:grader"],
      ["SENSORS", "service:intake"],
      ["DECIDED", "service:intake"],
    ]);

    const again = await submit(token, id, true);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id, state: "CURATOR_QUEUE", workflowId: `suggestion:${id}` });
    expect((await submit(token, id, false)).status).toBe(200);
    expect((await read(token, id)).status).toBe(200);
    expect((await remove(token, id)).status).toBe(409);
    expect((await patch(token, id, { rationale: "x" })).status).toBe(409);
  });

  it("calls no model: the gateway's ledger holds no new row for the suite's accounts (§ 10.8)", async () => {
    expect(await gatewayRows()).toBe(gatewayBefore);
  });
});
