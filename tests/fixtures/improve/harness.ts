import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { WorkflowHandle } from "@temporalio/client";

import { GET as authDev } from "@/app/api/v1/auth/dev/route";
import { PATCH as patchRoute } from "@/app/api/v1/suggestions/[id]/route";
import { POST as suggestionsRoute } from "@/app/api/v1/suggestions/route";
import { aliasesFromConfig, startStub } from "@/infra/gateway/stub/server";
import { resolveDevUser } from "@/lib/auth/link";
import type { BudgetRowInput } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { addEvidenceItem, type EvidenceInput, type UserCaller } from "@/lib/db/improve";
import { withSystem } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { GatewayDeps } from "@/lib/gateway/client";
import { encryptKey } from "@/lib/gateway/keys";
import type { SuggestionId } from "@/lib/schemas/ids";
import { evidenceSourceKey } from "@/lib/schemas/storage";
import { MERGE_STAGE_QUERY, MergeStageSchema, SUGGESTION_WAITS_QUERY, SuggestionWaitsSchema, type MergeStage, type SuggestionWaits } from "@/lib/schemas/workflows";
import { objectStore } from "@/lib/storage";
import { defaultEvidenceDeps, evidenceActivities } from "@/workers/activities/evidence";
import { defaultMergeDeps, mergeActivities } from "@/workers/activities/merge";
import { defaultSuggestionDeps, suggestionActivities } from "@/workers/activities/suggestion";
import { adjudicate } from "@/workers/agents/adjudicator/adjudicate";
import { gradeEvidence, type GradeEvidenceInput } from "@/workers/agents/grader/evidence";
import type { FetchOutcome } from "@/workers/fetch/fetch";

import type { ExampleItem, WorkedExample } from "./examples";

/*
 * What runs a worked example end to end (feature-specs/33 § 8; unit 50g), for its suite and for the development seed:
 * the stub gateway started in this process, its ledger rows kept here so that no model is asked and the gateway's own
 * ledger is not written; a fetcher given the fixture's documents; the workflow's real activities, wired to both; and
 * the example's draft made as a person makes one — signed in, through the create and patch endpoints, so that its
 * anchor is resolved and its class computed as for anyone — with its evidence added through the door and left
 * pending, for the workflow's own step 3 to grade. Since unit 54b an accept starts its merge: the merge's real
 * activities, with no repository of the book — the operator's, which no example and no seed writes, whatever the
 * environment names — so an accepted example waits in its merge as `UNAVAILABLE`.
 */

const FIXTURES = join(process.cwd(), "workers", "agents", "grader", "__fixtures__");
const DAY_MS = 86_400_000;

/** The stub gateway, running: what it was sent, the ledger rows its client appended, and a gateway client's deps on it. */
export interface StubGateway {
  readonly rows: BudgetRowInput[];
  readonly gateway: (headers?: Readonly<Record<string, string>>) => GatewayDeps;
  readonly close: () => Promise<void>;
}

export async function startStubGateway(): Promise<StubGateway> {
  const masterKey = randomBytes(24).toString("hex");
  const keySecret = randomBytes(32).toString("hex");
  const aliases = aliasesFromConfig(readFileSync(join(process.cwd(), "infra", "gateway", "litellm.yaml"), "utf8"));
  const stub = await startStub({ masterKey, aliases, port: 0, log: () => undefined });
  const minted = await fetch(`${stub.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" }, body: JSON.stringify({ models: [...aliases.keys()], max_budget: 1_000 }) });
  const key = ((await minted.json()) as { key: string }).key;
  const rows: BudgetRowInput[] = [];
  return {
    rows,
    gateway: (headers = {}) => ({
      baseUrl: stub.url,
      keySecret,
      findKey: async () => ({ keyCiphertext: encryptKey(keySecret, key) }),
      append: async (row) => {
        rows.push(row);
      },
      log: () => undefined,
      fetch: async (input, init) => {
        const merged = new Headers(init?.headers);
        for (const [name, value] of Object.entries(headers)) merged.set(name, value);
        return globalThis.fetch(input, { ...init, headers: merged });
      },
      now: () => new Date(),
    }),
    close: () => stub.close(),
  };
}

type LinkItem = Extract<ExampleItem, { kind: "LINK" }>;

/** The fixture's fetcher: each example's pages, opened, dated so many days before `now`; anything else refused. */
export function fixtureFetch(examples: ReadonlyArray<WorkedExample>, now: () => Date = () => new Date()): (url: string) => Promise<FetchOutcome> {
  const pages = new Map(examples.flatMap((example) => example.items.filter((item): item is LinkItem => item.kind === "LINK")).map((item) => [item.url, item]));
  return async (url) => {
    const fetchedAt = now();
    const page = pages.get(url);
    if (page === undefined) return { outcome: "unreachable", fetchStatus: "unreachable:404", cause: "404", at: url, url, redirects: 0, fetchedAt };
    const html = `<html><head><title>${page.document.title}</title></head><body><p>${page.document.text}</p></body></html>`;
    const body = Buffer.from(html, "utf8");
    const publishedOn = new Date(fetchedAt.getTime() - page.document.ageDays * DAY_MS).toISOString().slice(0, 10);
    return {
      outcome: "opened",
      fetchStatus: "opened:200",
      url,
      finalUrl: url,
      redirects: 0,
      contentType: "text/html",
      charset: "utf-8",
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      body,
      document: { kind: "html", title: page.document.title, text: page.document.text, publishedOn, canonicalUrl: null },
      fetchedAt,
    };
  };
}

/** The stub grader's answer for a document, by its title — an upload has none, and is the screenshot's. */
function gradeHeaderOf(examples: ReadonlyArray<WorkedExample>): (input: GradeEvidenceInput) => string {
  const byTitle = new Map(examples.flatMap((example) => example.items.flatMap((item) => (item.kind === "LINK" ? [[item.document.title, item.grade] as const] : []))));
  const upload = examples.flatMap((example) => example.items.flatMap((item) => (item.kind === "UPLOAD" ? [item.grade] : [])))[0] ?? "G";
  return (input) => byTitle.get(input.prompt.document.title ?? "") ?? upload;
}

/** The workflow's real activities, its own, the grader's and the merge's, on the stub gateway, the fixture's fetcher and no repository of the book. */
export function exampleActivities(stub: StubGateway, examples: ReadonlyArray<WorkedExample>): object {
  const gradeHeader = gradeHeaderOf(examples);
  const suggestion = suggestionActivities({ ...defaultSuggestionDeps(), adjudicate: (input) => adjudicate(input, { gateway: stub.gateway() }) });
  const evidence = evidenceActivities({
    ...defaultEvidenceDeps(),
    fetch: fixtureFetch(examples),
    openDoi: () => Promise.reject(new Error("no worked example cites a DOI")),
    grade: (input) => gradeEvidence(input, { gateway: stub.gateway({ "x-hb-stub-grade": gradeHeader(input) }), now: () => new Date() }),
  });
  const merge = mergeActivities({ ...defaultMergeDeps(), repo: () => Promise.reject(new AppError("BOOK_REPO_UNAVAILABLE", "no worked example writes the book's repository (feature-specs/37 § 3).")) });
  return { ...suggestion, ...evidence, ...merge };
}

/** A contributor, signed in through the development provider, verified, and with their consent to provenance on file. */
export interface ExampleContributor {
  readonly email: string;
  readonly token: string;
  readonly caller: UserCaller;
}

const base = (): string => env.APP_URL.replace(/\/$/, "");
const headersOf = (token: string, address: string): Record<string, string> => ({ "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": address, cookie: `hb.session=${token}` });

export async function signInContributor(email: string, address: string): Promise<ExampleContributor> {
  const response = await authDev(new Request(`${base()}/api/v1/auth/dev?email=${encodeURIComponent(email)}&role=CONTRIBUTOR&verified=true&next=/en`, { headers: { "x-forwarded-for": address } }), { params: Promise.resolve({}) });
  const token = /hb\.session=([^;]+)/.exec(response.headers.getSetCookie().join("\n"))?.[1];
  if (token === undefined) throw new Error(`signing in ${email} gave no session (${String(response.status)})`);
  const { userId } = await resolveDevUser(email, "en");
  /* The consent a person gives with their first submission (31 § 6.2): on file, as the workflow's move out of draft requires (invariant 25). */
  await withSystem(() => getPrisma().user.update({ where: { id: userId }, data: { provenanceConsentAt: new Date() } }));
  return { email, token, caller: { kind: "user", userId, role: "CONTRIBUTOR", parts: [] } };
}

/**
 * An example account's suggestions gone, with their stored evidence: back to draft so that they can go — a move
 * nothing of the product makes — in one transaction, so that a row holding one back leaves nothing half removed. The
 * suite removes its account too, with its sessions, since nobody signs in as it. The development seed keeps its own:
 * a person may sign in as it and leave bookmarks, notes or conversations, which would hold the account back. The
 * ledger keeps their records, as it keeps every record.
 */
async function clearExample(email: string, account: "keep" | "remove"): Promise<void> {
  const ids = await withSystem(() =>
    getPrisma().$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { email }, select: { id: true } });
      if (user === null) return [];
      const made = await tx.suggestion.findMany({ where: { userId: user.id }, select: { id: true } });
      await tx.suggestion.updateMany({ where: { userId: user.id, state: { not: "DRAFT" } }, data: { state: "DRAFT", submittedAt: null, workflowId: null } });
      await tx.suggestion.deleteMany({ where: { userId: user.id, state: "DRAFT" } });
      if (account === "remove") {
        await tx.session.deleteMany({ where: { userId: user.id } });
        await tx.authEvent.deleteMany({ where: { userId: user.id } });
        await tx.user.delete({ where: { id: user.id } });
      }
      return made.map((suggestion) => suggestion.id);
    }),
  );
  for (const id of ids) await rm(join(env.OBJECT_STORE_DIR, "evidence", id), { recursive: true, force: true });
}

/** The suite's account and all it made, gone (above). */
export const clearExampleAccount = (email: string): Promise<void> => clearExample(email, "remove");

/** The seed's suggestions gone, its account kept (above). */
export const clearExampleSuggestions = (email: string): Promise<void> => clearExample(email, "keep");

/** Until the run waits for something — its `waits` query answers (33 § 20) — and that answer. */
export async function waitingOf(handle: WorkflowHandle): Promise<NonNullable<SuggestionWaits>> {
  for (let tries = 0; tries < 600; tries += 1) {
    const waits = SuggestionWaitsSchema.parse(await handle.query(SUGGESTION_WAITS_QUERY));
    if (waits !== null) return waits;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the run never waited");
}

/** Until the merge waits — its `stage` query answers a stage that is no step's (37 § 4; unit 54b) — and that stage. */
export async function mergeWaitingOf(handle: WorkflowHandle): Promise<MergeStage> {
  for (let tries = 0; tries < 600; tries += 1) {
    const stage = await handle
      .query(MERGE_STAGE_QUERY)
      .then((answer) => MergeStageSchema.parse(answer))
      .catch(() => null);
    if (stage !== null && stage !== "PREPARING" && stage !== "CHECKING") return stage;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the merge never waited");
}

/** The example's draft, made through the endpoints, with its evidence added and left pending; its id. */
export async function draftExample(example: WorkedExample, contributor: ExampleContributor, address: string): Promise<SuggestionId> {
  const headers = headersOf(contributor.token, address);
  const created = await suggestionsRoute(
    new Request(`${base()}/api/v1/suggestions`, { method: "POST", headers: { ...headers, "idempotency-key": randomUUID() }, body: JSON.stringify({ anchor: example.anchor, changeKind: example.changeKind, locale: "en" }) }),
    { params: Promise.resolve({}) },
  );
  if (created.status !== 200) throw new Error(`${example.name}: the draft was refused (${String(created.status)}: ${await created.text()})`);
  const id = ((await created.json()) as { id: SuggestionId }).id;
  const patched = await patchRoute(new Request(`${base()}/api/v1/suggestions/${id}`, { method: "PATCH", headers, body: JSON.stringify({ proposal: example.proposal, rationale: example.rationale }) }), { params: Promise.resolve({ id }) });
  if (patched.status !== 200) throw new Error(`${example.name}: the proposal was refused (${String(patched.status)}: ${await patched.text()})`);

  /* The door adds nothing to a suggestion not open or at its limit, and says so: an example short of an item is not the example. */
  const add = async (input: EvidenceInput): Promise<void> => {
    const added = await addEvidenceItem(contributor.caller, id, input, 10);
    if (!added.added) throw new Error(`${example.name}: an evidence item was not added (${added.reason})`);
  };
  for (const item of example.items) {
    const itemId = randomUUID();
    if (item.kind === "LINK") {
      await add({ id: itemId, kind: "LINK", url: item.url, doi: null, storageKey: null, host: new URL(item.url).hostname });
    } else if (item.kind === "UPLOAD") {
      const key = evidenceSourceKey(id, itemId);
      await objectStore().put(key, readFileSync(join(FIXTURES, item.file)), item.contentType);
      await add({ id: itemId, kind: "UPLOAD", url: null, doi: null, storageKey: key, host: null });
    } else {
      /* A saved run arrives with the IDE (32 § 3): written as it would leave it, graded, so that no grader is asked. */
      await withSystem(() =>
        getPrisma().evidenceItem.create({
          data: { id: itemId, suggestionId: id, ordinal: 1, kind: "LAB_RUN", state: "GRADED", labRunId: item.labRunId, fetchStatus: "opened:200", tier: "A", baseScore: 100, relevance: item.relevance, recency: 1, independence: 1, adjustedScore: item.adjusted, reason: item.reason, gradedBy: "worked-example", gradedAt: new Date() },
        }),
      );
    }
  }
  return id;
}
