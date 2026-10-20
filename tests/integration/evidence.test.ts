import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as authDev } from "@/app/api/v1/auth/dev/route";
import { DELETE as deleteItemRoute } from "@/app/api/v1/suggestions/[id]/evidence/[itemId]/route";
import { POST as addRoute } from "@/app/api/v1/suggestions/[id]/evidence/route";
import { DELETE as deleteDraftRoute, GET as readRoute, PATCH as patchRoute } from "@/app/api/v1/suggestions/[id]/route";
import { POST as suggestionsRoute } from "@/app/api/v1/suggestions/route";
import { resolveDevUser } from "@/lib/auth/link";
import { contributorForGrading } from "@/lib/db/account";
import { resolveAnchor } from "@/lib/db/anchors";
import { getPrisma } from "@/lib/db/client";
import { addEvidenceItem, callerOf, readRubricVersion } from "@/lib/db/improve";
import { withSystem } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { loadGuide } from "@/lib/guides/load";
import { loadRubric } from "@/lib/rubrics/load";
import { EvidenceAddedSchema, EvidenceDeletedSchema } from "@/lib/schemas/evidence";
import { evidenceSourceKey, evidenceTextKey } from "@/lib/schemas/storage";
import { SuggestionViewSchema } from "@/lib/schemas/suggestions";
import { getObject, headObject, objectStore, type ObjectStore } from "@/lib/storage";
import { evidenceActivities, TEXT_HEAD_BYTES, type EvidenceActivityDeps } from "@/workers/activities/evidence";
import type { GradeEvidenceInput } from "@/workers/agents/grader/evidence";
import type { FetchOutcome, Opened } from "@/workers/fetch/fetch";

/*
 * Evidence graded on add, against the database, the sidecar and the store (feature-specs/32 § 8, § 13.7, § 13.8).
 * Two halves. The activities, with the fetcher and the grader doubled so that nothing reaches the network or a
 * model: a link fetched, its bytes stored under `source`, its text extracted and stored under `text`, graded and
 * written to the row with its arithmetic; the suggestion's view then carrying the score and the prediction computed
 * from the rows; a 403 as `U` by intake rules with no grade asked; a budget refusal leaving the item pending with
 * the reset date. And the endpoints on the real engine, with the one link that can reach no model — one the guard
 * refuses by name — so the dev workers, which grade with the real gateway, grade nothing: the add answers 202, the
 * workers run the workflow to `U`, the delete removes an item. Runs where DATABASE_URL, OPA_URL, AUTH_DEV_PROVIDER
 * and OBJECT_STORE_SECRET are set; the engine half where TEMPORAL_ADDRESS is too. Since unit 49f (§ 9), in a draft
 * of their own: PDFs and images, uploaded and linked, graded as bytes from a copy under the `text` key that a source
 * PUT again afterwards does not reach; a source changed before it was stored, an image too wide and a PNG given as a
 * PDF, `U` by intake rules with no grade asked; a page decoded by the charset its response named; a long text upload
 * read only as far as the grader can use, and flagged as cut.
 */

const ready = env.DATABASE_URL !== undefined && env.OPA_URL !== undefined && env.AUTH_DEV_PROVIDER === "1" && env.OBJECT_STORE_SECRET !== undefined;
const engine = ready && env.TEMPORAL_ADDRESS !== undefined && env.TEMPORAL_NAMESPACE !== undefined;

const CONTRIBUTOR = "evidence-contributor@harness-bible.local";
const EMAILS = [CONTRIBUTOR];
const ADDRESS = `2001:db8:4::${Date.now().toString(16)}`;
const base = env.APP_URL.replace(/\/$/, "");
const PAGE = '<html><head><title>Pricing — Provider Two</title><meta property="article:published_time" content="2026-07-14"></head><body><h1>Team plan</h1><p>Retries are billed as requests unless the Idempotency-Key header is present.</p><script>no()</script></body></html>';

const tokens: Record<string, string> = {};
const written: string[] = [];

async function signIn(email: string): Promise<string> {
  const response = await authDev(new Request(`${base}/api/v1/auth/dev?email=${encodeURIComponent(email)}&role=CONTRIBUTOR&verified=true&next=/en`, { headers: { "x-forwarded-for": ADDRESS } }), { params: Promise.resolve({}) });
  expect(response.status).toBe(302);
  return /hb\.session=([^;]+)/.exec(response.headers.getSetCookie().join("\n"))?.[1] ?? "";
}

const headersOf = (token: string): Record<string, string> => ({ "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": ADDRESS, cookie: `hb.session=${token}` });
const PASSAGE_EDIT = { kind: "EDIT_TEXT", before: "Retries are not optional at eleven steps.", after: "Retries are required at eleven steps." } as const;
const createDraft = async (token: string, proposal: { readonly kind: string } = PASSAGE_EDIT): Promise<string> => {
  const created = await suggestionsRoute(new Request(`${base}/api/v1/suggestions`, { method: "POST", headers: { ...headersOf(token), "idempotency-key": randomUUID() }, body: JSON.stringify({ anchor: { kind: "SECTION", id: "21.3" }, changeKind: proposal.kind, locale: "en" }) }), { params: Promise.resolve({}) });
  expect(created.status, await created.clone().text()).toBe(200);
  const id = ((await created.json()) as { id: string }).id;
  const patched = await patchRoute(new Request(`${base}/api/v1/suggestions/${id}`, { method: "PATCH", headers: headersOf(token), body: JSON.stringify({ proposal, rationale: "integration suite." }) }), { params: Promise.resolve({ id }) });
  expect(patched.status).toBe(200);
  return id;
};
const read = (token: string, id: string): Promise<Response> => readRoute(new Request(`${base}/api/v1/suggestions/${id}`, { headers: headersOf(token) }), { params: Promise.resolve({ id }) });
const add = (token: string, id: string, body: unknown): Promise<Response> => addRoute(new Request(`${base}/api/v1/suggestions/${id}/evidence`, { method: "POST", headers: { ...headersOf(token), "idempotency-key": randomUUID() }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const removeItem = (token: string, id: string, itemId: string): Promise<Response> => deleteItemRoute(new Request(`${base}/api/v1/suggestions/${id}/evidence/${itemId}`, { method: "DELETE", headers: headersOf(token) }), { params: Promise.resolve({ id, itemId }) });

async function cleanup(): Promise<void> {
  await withSystem(async () => {
    const prisma = getPrisma();
    const ids = (await prisma.user.findMany({ where: { email: { in: EMAILS } }, select: { id: true } })).map((user) => user.id);
    await prisma.suggestion.deleteMany({ where: { userId: { in: ids }, state: "DRAFT" } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.authEvent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
  for (const suggestionId of written) await rm(`${env.OBJECT_STORE_DIR}/evidence/${suggestionId}`, { recursive: true, force: true });
}

const FIXTURES = join(process.cwd(), "workers", "agents", "grader", "__fixtures__");
/* A page in Latin-1 whose charset only the response's header names (unit 49f: the source keeps it). */
const LATIN = Buffer.from("<html><body><p>Pre\u00e7o por requisi\u00e7\u00e3o: R$ 0,02.</p></body></html>", "latin1");
/* The same, declaring its charset itself, served under a label no decoder knows (`latin-1`). */
const LATIN_DECLARED = Buffer.from('<html><head><meta charset="iso-8859-1"></head><body><p>Pre\u00e7o por requisi\u00e7\u00e3o: R$ 0,02.</p></body></html>', "latin1");

/** The fetcher doubled: one page it opens, a Latin-1 page, a linked PDF, and one it is refused. */
const fetchDouble = async (url: string): Promise<FetchOutcome> => {
  const fetchedAt = new Date("2026-10-06T12:00:00Z");
  const opened = (body: Buffer, contentType: string, charset: string | null, document: Opened["document"]): FetchOutcome =>
    ({ outcome: "opened", fetchStatus: "opened:200", url, finalUrl: url, redirects: 0, contentType, charset, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), body, document, fetchedAt });
  if (url === "https://pages.example/pricing") return opened(Buffer.from(PAGE, "utf8"), "text/html", "utf-8", { kind: "html", title: "Pricing — Provider Two", text: "Team plan\nRetries are billed as requests unless the Idempotency-Key header is present.", publishedOn: "2026-07-14", canonicalUrl: null });
  if (url === "https://pages.example/latin") return opened(LATIN, "text/html", "iso-8859-1", { kind: "html", title: null, text: "Preço por requisição: R$ 0,02.", publishedOn: null, canonicalUrl: null });
  if (url === "https://pages.example/latin-label") return opened(LATIN_DECLARED, "text/html", "latin-1", { kind: "html", title: null, text: "Preço por requisição: R$ 0,02.", publishedOn: null, canonicalUrl: null });
  if (url === "https://pages.example/paper.pdf") {
    const pdf = readFileSync(join(FIXTURES, "C-vendor.pdf"));
    return opened(pdf, "application/pdf", null, { kind: "bytes", mediaType: "application/pdf", bytes: pdf });
  }
  return { outcome: "unreachable", fetchStatus: "unreachable:403", cause: "403", at: url, url, redirects: 0, fetchedAt };
};

const graded: GradeEvidenceInput[] = [];
let budget = false;

const deps: EvidenceActivityDeps = {
  fetch: fetchDouble,
  openDoi: () => Promise.reject(new Error("no DOI in this suite")),
  store: objectStore,
  grade: async (input) => {
    graded.push(input);
    if (budget) throw new BudgetExceededError(new Date("2026-11-01T00:00:00Z"), "the principal's budget is spent");
    const { content } = input.prompt.document;
    const text = content.kind === "text" ? content.text : null;
    return { graded: true, tier: "C", relevance: "direct", stake: "vendor", publishedOn: input.prompt.document.publishedOn, ageDays: 84, factors: { relevance: 1, recency: 1, independence: 0.8 }, base: 70, adjusted: 56, reason: "the vendor's own pricing page states the figure", gradedBy: "suite-model", usage: null, contentSha256: createHash("sha256").update(content.kind === "text" ? content.text : content.data).digest("hex"), text, truncated: false };
  },
  researchPrincipal: () => null,
  contributorId: async (suggestionId) => (await withSystem(() => getPrisma().suggestion.findUnique({ where: { id: suggestionId }, select: { userId: true } })))?.userId ?? null,
  contributor: contributorForGrading,
  anchor: resolveAnchor,
  rubricVersion: readRubricVersion,
  loadRubric,
  guide: () => loadGuide("grader", "v1.3"),
  now: () => new Date("2026-10-06T12:00:00Z"),
};

describe.skipIf(!ready)("evidence graded on add, against the database, the sidecar and the store", () => {
  let draftId = "";
  let caller: ReturnType<typeof callerOf>;

  beforeAll(async () => {
    await cleanup();
    tokens.contributor = await signIn(CONTRIBUTOR);
    const user = await resolveDevUser(CONTRIBUTOR, "en");
    caller = callerOf({ id: user.userId, role: "CONTRIBUTOR", parts: [] });
    draftId = await createDraft(tokens.contributor ?? "");
    written.push(draftId);
  }, 120_000);

  afterAll(cleanup);

  it("the activities: fetch stores the bytes and the facts, the text is extracted and stored, the grade is written with its arithmetic, and the view carries the score and the prediction", async () => {
    const itemId = randomUUID();
    const added = await addEvidenceItem(caller, draftId, { id: itemId, kind: "LINK", url: "https://pages.example/pricing", doi: null, storageKey: null, host: "pages.example" }, 10);
    expect(added).toMatchObject({ added: true, item: { state: "PENDING", ordinal: 1 } });
    const activities = evidenceActivities(deps);

    expect(await activities.fetchItem(itemId)).toEqual({ opened: true, fetchStatus: "opened:200" });
    const source = await headObject(evidenceSourceKey(draftId, itemId));
    expect(source).toMatchObject({ contentType: "text/html; charset=utf-8", bytes: Buffer.byteLength(PAGE) });
    let row = await withSystem(() => getPrisma().evidenceItem.findUniqueOrThrow({ where: { id: itemId } }));
    expect(row).toMatchObject({ state: "PENDING", fetchStatus: "opened:200", host: "pages.example", title: "Pricing — Provider Two", contentSha256: source?.sha256 });
    expect(row.publishedOn?.toISOString().slice(0, 10)).toBe("2026-07-14");
    /* Run again: nothing is fetched twice. */
    expect(await activities.fetchItem(itemId)).toEqual({ opened: true, fetchStatus: "opened:200" });

    expect(await activities.storeText(itemId)).toEqual({ text: true });
    const text = await getObject(evidenceTextKey(draftId, itemId));
    expect(text).not.toBeNull();
    const stored = (await drain(text?.body)).toString("utf8");
    expect(stored).toContain("Retries are billed as requests");
    expect(stored).not.toContain("no()");
    row = await withSystem(() => getPrisma().evidenceItem.findUniqueOrThrow({ where: { id: itemId } }));
    expect(row.textKey).toBe(evidenceTextKey(draftId, itemId));

    graded.length = 0;
    expect(await activities.gradeItem(itemId)).toEqual({ state: "GRADED", tier: "C" });
    expect(graded).toHaveLength(1);
    const input = graded[0] as GradeEvidenceInput;
    expect(input.prompt.document).toMatchObject({ kind: "LINK", host: "pages.example", mediaType: "text/html", title: "Pricing — Provider Two", publishedOn: "2026-07-14", content: { kind: "text", text: stored } });
    expect(input.prompt.anchor).toMatchObject({ kind: "SECTION", id: "21.3", chapter: 21, fastMoving: false });
    expect(input.prompt.change).toEqual({ kind: "EDIT_TEXT", anchoredPassage: "Retries are not optional at eleven steps.", proposedText: "Retries are required at eleven steps." });
    expect(input.prompt.guide.version).toBe("v1.3");
    expect(input.prompt.rubric.version).toBe("v1.2");
    expect(input.independence).toEqual({ publisherHost: "pages.example", contributorEmail: CONTRIBUTOR });
    expect(input.call).toMatchObject({ principal: { userId: caller.userId }, ref: draftId });
    row = await withSystem(() => getPrisma().evidenceItem.findUniqueOrThrow({ where: { id: itemId } }));
    expect(row).toMatchObject({ state: "GRADED", tier: "C", baseScore: 70, adjustedScore: 56, reason: "the vendor's own pricing page states the figure", gradedBy: "suite-model", ageDays: 84 });
    expect(Number(row.independence)).toBe(0.8);
    /* Run again: the grade stands, no second call. */
    expect(await activities.gradeItem(itemId)).toEqual({ state: "GRADED", tier: "C" });
    expect(graded).toHaveLength(1);

    const view = SuggestionViewSchema.parse(await (await read(tokens.contributor ?? "", draftId)).json());
    expect(view.evidence).toHaveLength(1);
    expect(view.evidence[0]).toMatchObject({ id: itemId, state: "GRADED", tier: "C", baseScore: 70, relevance: 1, recency: 1, independence: 0.8, adjustedScore: 56, fetchStatus: "opened:200" });
    expect(view.scoring).toMatchObject({ score: 56, strongestItemId: itemId, corroboratedById: null, gradedItems: 1, pendingItems: 0, prediction: { decision: "ACCEPT", route: "ADJUDICATE" } });
    expect(view.scoring?.prediction.acceptAt).toBe(view.thresholds.acceptAt);
  });

  it("the activities: a claim added and declared fast-moving reaches the grader's prompt as fast-moving, whatever its section's flag (30 § 3.4)", async () => {
    const claimDraft = await createDraft(tokens.contributor ?? "", { kind: "ADD_CLAIM", text: "Provider tier 3 cut its batch price in September 2026.", placeAfter: "end", fastMoving: true } as unknown as { readonly kind: string });
    written.push(claimDraft);
    const itemId = randomUUID();
    expect(await addEvidenceItem(caller, claimDraft, { id: itemId, kind: "LINK", url: "https://pages.example/pricing", doi: null, storageKey: null, host: "pages.example" }, 10)).toMatchObject({ added: true });
    const activities = evidenceActivities(deps);
    expect(await activities.fetchItem(itemId)).toEqual({ opened: true, fetchStatus: "opened:200" });
    expect(await activities.storeText(itemId)).toEqual({ text: true });
    graded.length = 0;
    expect(await activities.gradeItem(itemId)).toMatchObject({ state: "GRADED" });
    expect((graded[0] as GradeEvidenceInput).prompt.anchor).toMatchObject({ kind: "SECTION", id: "21.3", fastMoving: true });
    expect(SuggestionViewSchema.parse(await (await read(tokens.contributor ?? "", claimDraft)).json())).toMatchObject({ changeKind: "ADD_CLAIM", fastMoving: true });
  });

  it("the activities: a 403 is U by intake rules with no grade asked, and a budget refusal leaves the item pending with the reset date", async () => {
    const activities = evidenceActivities(deps);
    const refused = randomUUID();
    await addEvidenceItem(caller, draftId, { id: refused, kind: "LINK", url: "https://pages.example/paywall", doi: null, storageKey: null, host: "pages.example" }, 10);
    graded.length = 0;
    expect(await activities.fetchItem(refused)).toEqual({ opened: false, fetchStatus: "unreachable:403" });
    const row = await withSystem(() => getPrisma().evidenceItem.findUniqueOrThrow({ where: { id: refused } }));
    expect(row).toMatchObject({ state: "GRADED", tier: "U", baseScore: 0, adjustedScore: 0, gradedBy: "intake-rules", reason: "403", fetchStatus: "unreachable:403" });
    expect(await activities.gradeItem(refused)).toEqual({ state: "GRADED", tier: "U" });
    expect(graded).toHaveLength(0);

    const capped = randomUUID();
    await addEvidenceItem(caller, draftId, { id: capped, kind: "LINK", url: "https://pages.example/pricing", doi: null, storageKey: null, host: "pages.example" }, 10);
    await activities.fetchItem(capped);
    await activities.storeText(capped);
    budget = true;
    try {
      /* the wait to the reset, measured by the activity's clock (unit 50f) */
      expect(await activities.gradeItem(capped)).toEqual({ state: "PENDING", resetsAt: "2026-11-01T00:00:00.000Z", waitMs: Date.parse("2026-11-01T00:00:00.000Z") - Date.parse("2026-10-06T12:00:00Z") });
    } finally {
      budget = false;
    }
    const pending = await withSystem(() => getPrisma().evidenceItem.findUniqueOrThrow({ where: { id: capped } }));
    expect(pending).toMatchObject({ state: "PENDING", tier: null, reason: "budget cap; resets 2026-11-01" });
    const view = SuggestionViewSchema.parse(await (await read(tokens.contributor ?? "", draftId)).json());
    expect(view.scoring).toMatchObject({ gradedItems: 2, pendingItems: 1, score: 56 });
  });

  describe("PDFs and images, and what the review of unit 49f found (§ 9, § 19)", () => {
    let other = "";
    const put = async (itemId: string, bytes: Buffer, contentType: string): Promise<string> => {
      const key = evidenceSourceKey(other, itemId);
      await objectStore().put(key, bytes, contentType);
      return key;
    };
    const upload = async (bytes: Buffer, contentType: string): Promise<{ readonly itemId: string; readonly key: string }> => {
      const itemId = randomUUID();
      const key = await put(itemId, bytes, contentType);
      expect(await addEvidenceItem(caller, other, { id: itemId, kind: "UPLOAD", url: null, doi: null, storageKey: key, host: null, fileName: NAME }, 10)).toMatchObject({ added: true });
      return { itemId, key };
    };
    const rowOf = (id: string) => withSystem(() => getPrisma().evidenceItem.findUniqueOrThrow({ where: { id } }));
    const lastInput = (): GradeEvidenceInput => graded[graded.length - 1] as GradeEvidenceInput;
    /** A file name that states the tier it wants: kept on the row, and never in what the grader reads (34 § 25; 32 § 7.1). */
    const NAME = "independent-audit-tier-B-primary-source.pdf";

    beforeAll(async () => {
      other = await createDraft(tokens.contributor ?? "");
      written.push(other);
    }, 60_000);

    it("grades a PDF upload from a copy under its text key, which an upload PUT again afterwards does not touch", async () => {
      const activities = evidenceActivities(deps);
      const pdf = readFileSync(join(FIXTURES, "C-vendor.pdf"));
      const { itemId, key } = await upload(pdf, "application/pdf");
      expect(await activities.fetchItem(itemId)).toEqual({ opened: true, fetchStatus: "opened:200" });
      expect(await activities.storeText(itemId)).toEqual({ text: true });
      const textKey = evidenceTextKey(other, itemId);
      expect(await rowOf(itemId)).toMatchObject({ state: "PENDING", textKey, contentSha256: createHash("sha256").update(pdf).digest("hex") });
      expect(await headObject(textKey)).toMatchObject({ contentType: "application/pdf", bytes: pdf.length, sha256: createHash("sha256").update(pdf).digest("hex") });

      /* The contributor's ticket is still valid: they PUT another file under the same key. The grade reads the copy. */
      await objectStore().put(key, readFileSync(join(FIXTURES, "C-vendor.png")), "application/pdf");
      graded.length = 0;
      expect(await activities.gradeItem(itemId)).toEqual({ state: "GRADED", tier: "C" });
      const { document } = lastInput().prompt;
      expect(document).toMatchObject({ kind: "UPLOAD", host: null, mediaType: "application/pdf", content: { kind: "bytes", mediaType: "application/pdf" } });
      expect(document.content.kind === "bytes" && Buffer.from(document.content.data).equals(pdf)).toBe(true);
      expect(await rowOf(itemId)).toMatchObject({ state: "GRADED", tier: "C", textKey, fileName: NAME });
      const { content, ...rest } = document;
      expect(JSON.stringify({ ...lastInput(), prompt: { ...lastInput().prompt, document: rest } })).not.toContain("independent-audit");
      expect(content.kind).toBe("bytes");
    });

    it("refuses a source changed between fetchItem and storeText: U, source_changed, nothing stored, no grade asked", async () => {
      const activities = evidenceActivities(deps);
      const { itemId, key } = await upload(readFileSync(join(FIXTURES, "C-vendor.pdf")), "application/pdf");
      expect(await activities.fetchItem(itemId)).toEqual({ opened: true, fetchStatus: "opened:200" });
      await objectStore().put(key, Buffer.from("%PDF-1.4\n% another file under the same ticket\n%%EOF\n"), "application/pdf");
      graded.length = 0;
      expect(await activities.storeText(itemId)).toEqual({ text: false });
      expect(await rowOf(itemId)).toMatchObject({ state: "GRADED", tier: "U", reason: "source_changed", gradedBy: "intake-rules", textKey: null });
      expect(await headObject(evidenceTextKey(other, itemId))).toBeNull();
      expect(await activities.gradeItem(itemId)).toEqual({ state: "GRADED", tier: "U" });
      expect(graded).toHaveLength(0);
    });

    it("grades a PNG and a JPEG upload as image blocks of their own types, and refuses one wider than 8000 px and a PNG given as a PDF", async () => {
      const activities = evidenceActivities(deps);
      for (const [file, type] of [["C-vendor.png", "image/png"], ["C-vendor.jpg", "image/jpeg"]] as const) {
        const bytes = readFileSync(join(FIXTURES, file));
        const { itemId } = await upload(bytes, type);
        await activities.fetchItem(itemId);
        expect(await activities.storeText(itemId), type).toEqual({ text: true });
        graded.length = 0;
        expect(await activities.gradeItem(itemId), type).toEqual({ state: "GRADED", tier: "C" });
        const { document } = lastInput().prompt;
        expect(document, type).toMatchObject({ mediaType: type, content: { kind: "bytes", mediaType: type } });
        expect(document.content.kind === "bytes" && Buffer.from(document.content.data).equals(bytes), type).toBe(true);
      }
      const wide = Buffer.from(readFileSync(join(FIXTURES, "C-vendor.png")));
      wide.writeUInt32BE(8001, 16);
      const tooWide = await upload(wide, "image/png");
      await activities.fetchItem(tooWide.itemId);
      expect(await activities.storeText(tooWide.itemId)).toEqual({ text: false });
      expect(await rowOf(tooWide.itemId)).toMatchObject({ state: "GRADED", tier: "U", reason: "image_dimensions", gradedBy: "intake-rules" });
      const mismatched = await upload(readFileSync(join(FIXTURES, "C-vendor.png")), "application/pdf");
      await activities.fetchItem(mismatched.itemId);
      expect(await activities.storeText(mismatched.itemId)).toEqual({ text: false });
      expect(await rowOf(mismatched.itemId)).toMatchObject({ tier: "U", reason: "media_mismatch", textKey: null });
    });

    it("grades a linked PDF as bytes with its host, its source not checked as an upload's is, and decodes a Latin-1 page by its response's charset, or by its own declaration when the response's is no label", async () => {
      const activities = evidenceActivities(deps);
      const linked = randomUUID();
      await addEvidenceItem(caller, other, { id: linked, kind: "LINK", url: "https://pages.example/paper.pdf", doi: null, storageKey: null, host: "pages.example" }, 10);
      await activities.fetchItem(linked);
      expect(await headObject(evidenceSourceKey(other, linked))).toMatchObject({ contentType: "application/pdf" });
      /* Only fetchItem writes a link's source; two overlapping attempts of it could leave the row and the store apart. */
      await objectStore().put(evidenceSourceKey(other, linked), Buffer.concat([readFileSync(join(FIXTURES, "C-vendor.pdf")), Buffer.from([0x0a])]), "application/pdf");
      expect(await activities.storeText(linked)).toEqual({ text: true });
      graded.length = 0;
      await activities.gradeItem(linked);
      expect(lastInput().prompt.document).toMatchObject({ kind: "LINK", host: "pages.example", mediaType: "application/pdf", content: { kind: "bytes" } });

      const latin = randomUUID();
      await addEvidenceItem(caller, other, { id: latin, kind: "LINK", url: "https://pages.example/latin", doi: null, storageKey: null, host: "pages.example" }, 10);
      await activities.fetchItem(latin);
      expect(await headObject(evidenceSourceKey(other, latin))).toMatchObject({ contentType: "text/html; charset=iso-8859-1" });
      expect(await activities.storeText(latin)).toEqual({ text: true });
      const stored = (await drain((await getObject(evidenceTextKey(other, latin)))?.body)).toString("utf8");
      expect(stored).toContain("Preço por requisição");

      const labelled = randomUUID();
      await addEvidenceItem(caller, other, { id: labelled, kind: "LINK", url: "https://pages.example/latin-label", doi: null, storageKey: null, host: "pages.example" }, 10);
      await activities.fetchItem(labelled);
      expect(await activities.storeText(labelled)).toEqual({ text: true });
      expect((await drain((await getObject(evidenceTextKey(other, labelled)))?.body)).toString("utf8")).toContain("Preço por requisição");
    });

    it("reads a text upload only as far as the grader can use, and marks a text cut before storing so the fence says so", async () => {
      const activities = evidenceActivities(deps);
      /* 256,010 bytes: more than the 240,000 storeText reads of a text upload, as well as more than the grader's 60,000 characters. */
      const long = Buffer.from(`${"Retries are billed as requests. ".repeat(8000)}\n\nThe end.`, "utf8");
      expect(long.length).toBeGreaterThan(TEXT_HEAD_BYTES);
      const { itemId } = await upload(long, "text/plain");
      await activities.fetchItem(itemId);
      expect(await activities.storeText(itemId)).toEqual({ text: true });
      const textKey = evidenceTextKey(other, itemId);
      expect(await headObject(textKey)).toMatchObject({ contentType: "text/plain; charset=utf-8; truncated=true" });
      graded.length = 0;
      await activities.gradeItem(itemId);
      expect(lastInput().prompt.document.content).toMatchObject({ kind: "text", truncated: true });
      expect(await rowOf(itemId)).toMatchObject({ contentSha256: createHash("sha256").update(long).digest("hex") });
    });
  });

  it("the activities: an item deleted while a step stored its object leaves no object behind, since no row names it (45 § 4)", async () => {
    /* the store as a step sees it, with the item's row deleted the moment the step's object is stored: the draft's own
       removal is past by then, and a cancel does not stop a running activity */
    const deletingAt = (key: string, itemId: string): (() => ObjectStore) => () => {
      const real = objectStore();
      return {
        ...real,
        put: async (...args: Parameters<ObjectStore["put"]>) => {
          const stored = await real.put(...args);
          if (args[0] === key) await withSystem(() => getPrisma().evidenceItem.deleteMany({ where: { id: itemId } }));
          return stored;
        },
      };
    };

    const fetched = randomUUID();
    await addEvidenceItem(caller, draftId, { id: fetched, kind: "LINK", url: "https://pages.example/pricing", doi: null, storageKey: null, host: "pages.example" }, 10);
    expect(await evidenceActivities({ ...deps, store: deletingAt(evidenceSourceKey(draftId, fetched), fetched) }).fetchItem(fetched)).toMatchObject({ fetchStatus: "opened:200" });
    expect(await headObject(evidenceSourceKey(draftId, fetched))).toBeNull();

    const texted = randomUUID();
    await addEvidenceItem(caller, draftId, { id: texted, kind: "LINK", url: "https://pages.example/pricing", doi: null, storageKey: null, host: "pages.example" }, 10);
    await evidenceActivities(deps).fetchItem(texted);
    expect(await headObject(evidenceSourceKey(draftId, texted))).not.toBeNull();
    expect(await evidenceActivities({ ...deps, store: deletingAt(evidenceTextKey(draftId, texted), texted) }).storeText(texted)).toEqual({ text: true });
    expect(await headObject(evidenceTextKey(draftId, texted))).toBeNull();
  });

  it("the draft's delete removes everything its evidence stored, an upload never added as an item included (45 § 4)", async () => {
    const token = tokens.contributor ?? "";
    const id = await createDraft(token);
    written.push(id);
    const itemId = randomUUID();
    await addEvidenceItem(caller, id, { id: itemId, kind: "LINK", url: "https://pages.example/pricing", doi: null, storageKey: null, host: "pages.example" }, 10);
    /* the item's source, as fetchItem would have stored it, and an upload PUT under a ticket that never became an item */
    await objectStore().put(evidenceSourceKey(id, itemId), Buffer.from(PAGE, "utf8"), "text/html; charset=utf-8");
    const neverAdded = randomUUID();
    await objectStore().put(evidenceSourceKey(id, neverAdded), Buffer.from("never added", "utf8"), "text/plain");

    const deleted = await deleteDraftRoute(new Request(`${base}/api/v1/suggestions/${id}`, { method: "DELETE", headers: headersOf(token) }), { params: Promise.resolve({ id }) });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await deleted.json()).toEqual({ id, deleted: true });
    expect(await headObject(evidenceSourceKey(id, itemId))).toBeNull();
    expect(await headObject(evidenceSourceKey(id, neverAdded))).toBeNull();
    expect(existsSync(join(env.OBJECT_STORE_DIR, "evidence", id))).toBe(false);
  });

  it("the endpoints on the real engine: a link the guard refuses is added, graded U by the workers with no model called, and removed (§ 13.7, § 13.8)", { timeout: 60_000 }, async () => {
    if (!engine) return;
    const token = tokens.contributor ?? "";
    const other = await createDraft(token);
    written.push(other);
    const response = await add(token, other, { kind: "LINK", url: "https://intranet.localdomain/private" });
    expect(response.status, await response.clone().text()).toBe(202);
    const added = EvidenceAddedSchema.parse(await response.json());
    expect(added).toMatchObject({ suggestionId: other, stage: "1 of 3", item: { kind: "LINK", state: "PENDING", ordinal: 1 } });
    expect(added.workflowId).toBe(`evidence:${added.item.id}`);

    let item: { state: string; fetchStatus: string | null; tier: string | null; gradedBy: string | null } | null = null;
    for (let tries = 0; tries < 60; tries++) {
      item = await withSystem(() => getPrisma().evidenceItem.findUnique({ where: { id: added.item.id }, select: { state: true, fetchStatus: true, tier: true, gradedBy: true } }));
      if (item?.state === "GRADED") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(item).toEqual({ state: "GRADED", fetchStatus: "unreachable:internal_name", tier: "U", gradedBy: "intake-rules" });

    const view = SuggestionViewSchema.parse(await (await read(token, other)).json());
    expect(view.evidence[0]).toMatchObject({ id: added.item.id, tier: "U", adjustedScore: 0 });
    expect(view.scoring).toMatchObject({ score: 0, gradedItems: 1, pendingItems: 0, prediction: { route: "DECLINE_AT_INTAKE", decision: "DECLINE" } });

    /* something the item stored, which its removal from a draft takes (45 § 4): a refused link stores nothing itself */
    await objectStore().put(evidenceSourceKey(other, added.item.id), Buffer.from("stored", "utf8"), "text/plain");
    const removed = await removeItem(token, other, added.item.id);
    expect(removed.status).toBe(200);
    expect(EvidenceDeletedSchema.parse(await removed.json())).toMatchObject({ suggestionId: other, itemId: added.item.id, removed: true, cancelled: false });
    /* an item that leaves a draft takes what it stored (45 § 4) */
    expect(existsSync(join(env.OBJECT_STORE_DIR, "evidence", other, added.item.id))).toBe(false);
    expect((await removeItem(token, other, added.item.id)).status).toBe(404);
    expect((await add(token, other, { kind: "LAB_RUN", labRunId: "x" })).status).toBe(422);
  });
});

async function drain(stream: Readable | undefined): Promise<Buffer> {
  if (stream === undefined) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
