import "dotenv/config";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { findGatewayKey } from "@/lib/db/gateway";
import { join } from "node:path";
import { format, inspect } from "node:util";

import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";

import { getPrisma } from "@/lib/db/client";
import { readSuggestionAsService, type SuggestionForService } from "@/lib/db/improve";
import { currentRelease } from "@/lib/db/shared";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { REPORTS_DIR } from "@/lib/gate/goldenRun";
import { CURATED_EVIDENCE_DIR, curatedRunFileName, readCuratedSet } from "@/lib/gate/suggestions";
import { AppError } from "@/lib/errors";
import type { CuratedItem, CuratedRun, CuratedRunItem } from "@/lib/schemas/curated";
import { SUGGESTION_WORKFLOW, suggestionWorkflowId } from "@/lib/schemas/workflows";
import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import type { WorkedExample } from "@/tests/fixtures/improve/examples";
import { clearExampleSuggestions, draftExample, exampleActivities, fixtureFetch, signInContributor, startStubGateway } from "@/tests/fixtures/improve/harness";
import { startTestServer } from "@/tests/workflows/server";
import { defaultEvidenceDeps, evidenceActivities } from "@/workers/activities/evidence";
import { defaultMergeDeps, mergeActivities } from "@/workers/activities/merge";
import { defaultSuggestionDeps, suggestionActivities } from "@/workers/activities/suggestion";
import { bundleWorkflows } from "@/workers/temporal";

/*
 * npm run gate:suggestions:run -- --stub | --real [--principal <organisation id>] [--limit N] — the curated set through
 * the real workflow (feature-specs/39 § 3): each item drafted through the endpoints by the run's own account, its
 * evidence documents served from the set's fixture files, the real `SuggestionWorkflow` on the test engine started
 * here with its real activities; on `--stub`, the stub gateway started here grades and adjudicates as the documents
 * were meant; on `--real`, the real gateway does, charged to the principal named, which is a paid run and Andre's to
 * start (39 D2) — this script never chooses it by itself. Writes pipeline/reports/suggestions-run-<release>-<grade>
 * [-<stamp>].json, which the gate reads; `--limit` makes a pilot, written as suggestions-pilot-…, which the gate does
 * not read. Needs the database, the policy sidecar and the development provider, as the seed does; not the engine.
 */

const EMAIL = "curated-run@harness-bible.local";
const ADDRESS = `2001:db8:c0::${Date.now().toString(16)}`;
const ITEM_LIMIT_MS = 180_000;

const held: string[] = [];
const logger = new DefaultLogger("WARN", (entry) => held.push(`[temporal ${entry.level}] ${entry.message}${entry.meta === undefined ? "" : ` ${inspect(entry.meta, { depth: 4, breakLength: 160 })}`}`));

interface Args {
  readonly grade: "stub" | "real";
  readonly principal: string | null;
  readonly limit: number | null;
}

function argsOf(argv: ReadonlyArray<string>): Args {
  const real = argv.includes("--real");
  const stub = argv.includes("--stub");
  if (real === stub) throw new Error("say --stub or --real");
  const at = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };
  const limit = at("--limit");
  return { grade: real ? "real" : "stub", principal: at("--principal"), limit: limit === null ? null : Number(limit) };
}

/** An item of the set as the harness drafts one: its documents as pages at the documents' domains, each meant a tier. */
function exampleOf(item: CuratedItem): WorkedExample {
  return {
    name: item.id,
    anchor: item.anchor,
    changeKind: item.changeKind,
    proposal: item.proposal,
    rationale: item.rationale,
    items: item.evidence.map((document) => {
      const text = existsSync(join(CURATED_EVIDENCE_DIR, document.file)) ? readFileSync(join(CURATED_EVIDENCE_DIR, document.file), "utf8") : "";
      const ageDays = document.dated === null ? 4000 : Math.max(0, Math.round((Date.now() - new Date(`${document.dated}T00:00:00Z`).getTime()) / 86_400_000));
      const domain = document.meantTier === "U" ? "unreachable.invalid" : (document.domain ?? "source.example");
      /* the stub grades as the document was meant: its tier, its relevance, and the vendor's stake where the domain is the figure's vendor's */
      const stake = document.domain !== null && document.domain === item.vendorDomain ? "vendor" : "none";
      return { kind: "LINK", url: `https://${domain}/${document.file}`, document: { title: document.file.replace(/\.txt$/, ""), text, ageDays }, grade: `${document.meantTier}:${document.meantRelevance}:${stake}` };
    }),
    /* the run records where each ended; nothing here is checked against an end */
    ends: { state: "DECIDED", score: 0, route: "ADJUDICATE", decision: null, decidedBy: "adjudicator", sufficientTier: null, waits: null, merge: null, records: [] },
  } as unknown as WorkedExample;
}

/** The examples as the fetcher serves them: a document meant unreadable is left out, so its URL is one the fetcher does not hold and answers `unreachable`, and the item is U by the intake's rules with no grader asked. */
function servedOf(examples: ReadonlyArray<WorkedExample>, items: ReadonlyArray<CuratedItem>): ReadonlyArray<WorkedExample> {
  return examples.map((example, index) => ({ ...example, items: example.items.filter((_item, k) => items[index]?.evidence[k]?.meantTier !== "U") }));
}

/** Until the row is decided or waits where a person acts: its decision written, or its state one the run leaves it in. */
async function decidedOf(id: string): Promise<SuggestionForService | null> {
  const started = Date.now();
  for (;;) {
    const row = await readSuggestionAsService({ kind: "service", id: "service:intake" }, id);
    if (row !== null && (row.adjudication !== null || ["INTAKE_DECLINED", "DECIDED", "CURATOR_QUEUE", "MERGING", "MERGED"].includes(row.state))) return row;
    if (Date.now() - started > ITEM_LIMIT_MS) return row;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main(): Promise<number> {
  const args = argsOf(process.argv.slice(2));
  if (env.DATABASE_URL === undefined || env.OPA_URL === undefined || env.AUTH_DEV_PROVIDER !== "1") {
    console.error("gate:suggestions:run needs DATABASE_URL, OPA_URL and AUTH_DEV_PROVIDER=1, as the seed does.");
    return 1;
  }
  if (args.grade === "real") {
    /* a real run is charged to an organisation that holds a gateway key: both checked before anything is drafted or cleared */
    if (args.principal === null) {
      console.error("--real needs --principal <organisation id>: the run is charged to it (feature-specs/40 § 7.1, 39 D2).");
      return 1;
    }
    const organisation = await getPrisma().organisation.findUnique({ where: { id: args.principal }, select: { id: true } });
    if (organisation === null) {
      console.error(`--principal ${args.principal} is no organisation.`);
      return 1;
    }
    if ((await findGatewayKey({ organisationId: args.principal })) === null) {
      console.error(`organisation ${args.principal} holds no gateway key: a real run would make no call and grade everything U.`);
      return 1;
    }
  }
  const release = await currentRelease();
  const set = readCuratedSet(release.id);
  if (set === null) {
    console.error(`no set for release ${release.id}: npm run gate:suggestions writes it.`);
    return 1;
  }
  const items = args.limit === null ? set : set.slice(0, args.limit);
  const pilot = args.limit !== null;
  const startedAt = new Date();
  console.log(`gate:suggestions:run · release ${release.id} · ${args.grade} · ${String(items.length)} item(s)${pilot ? " (a pilot)" : ""}${args.grade === "real" ? ` · charged to ${args.principal ?? "the run's own account"}` : ""}`);

  Runtime.install({ logger, telemetryOptions: { logging: { forward: {} } } });
  console.info = (...parts: unknown[]) => void held.push(format(...parts));
  const started: Array<() => unknown> = [];
  try {
    const examples = items.map(exampleOf);
    const served = servedOf(examples, items);
    let activities: object;
    if (args.grade === "stub") {
      const stub = await startStubGateway();
      started.push(() => stub.close());
      activities = exampleActivities(stub, served);
    } else {
      /* the real activities on the real gateway, the documents served from the set's files, no repository of the book */
      activities = {
        ...suggestionActivities(defaultSuggestionDeps()),
        ...evidenceActivities({ ...defaultEvidenceDeps(), fetch: fixtureFetch(served), openDoi: () => Promise.reject(new Error("no curated item cites a DOI")) }),
        ...mergeActivities({ ...defaultMergeDeps(), repo: () => Promise.reject(new AppError("BOOK_REPO_UNAVAILABLE", "the curated run writes no repository of the book")) }),
      };
    }
    const server = await startTestServer();
    started.push(() => server.teardown());
    const taskQueue = "curated-run";
    const worker = await Worker.create({ connection: server.nativeConnection, taskQueue, workflowBundle: await bundleWorkflows(logger), activities });
    started.push(await acquire(LEDGER_LOCK));
    await clearExampleSuggestions(EMAIL);
    const contributor = await signInContributor(EMAIL, ADDRESS);
    /* the run's account is synthetic and drafts a hundred: the endpoint's twenty-a-day bucket is emptied for it, as the gate's own turns empty theirs (tests/integration/gate-turns.test.ts), and the throttle it would earn by the set's unreadable items (33 § 7, P4.9's suite) is lifted after each item */
    const unthrottled = async (): Promise<void> => {
      await withSystem(async () => {
        await getPrisma().rateLimitBucket.deleteMany({ where: { key: { startsWith: `user:${contributor.caller.userId}:` } } });
        await getPrisma().user.update({ where: { id: contributor.caller.userId }, data: { throttledUntil: null } });
      });
    };
    await unthrottled();
    const principalId = args.principal ?? contributor.caller.userId;
    if (args.grade === "real" && args.principal !== null) {
      /* the run's account is a member of the organisation named, so its calls are charged to it (11 § 3.4) */
      await withSystem(() => getPrisma().user.update({ where: { id: contributor.caller.userId }, data: { organisationId: args.principal } }));
    }
    const tenant = args.principal === null ? { userId: contributor.caller.userId, organisationId: null } : { userId: null, organisationId: args.principal };

    const runItems: CuratedRunItem[] = [];
    await worker.runUntil(async () => {
      for (const [index, item] of items.entries()) {
        const example = examples[index];
        if (example === undefined) continue;
        let suggestionId: string | null = null;
        try {
          suggestionId = await draftExample(example, contributor, ADDRESS);
          const handle = await server.client.workflow.start(SUGGESTION_WORKFLOW, { taskQueue, workflowId: suggestionWorkflowId(suggestionId), args: [{ suggestionId }] });
          const row = await decidedOf(suggestionId);
          await handle.terminate("the curated run ends with the run").catch(() => undefined);
          const cost = await withTenant(tenant, () => getPrisma().budgetLedger.aggregate({ where: { ref: suggestionId ?? "" }, _sum: { costUsd: true } }));
          runItems.push({
            id: item.id,
            suggestionId,
            decision: row?.outcome ?? null,
            decidedBy: row?.adjudication?.decidedBy === "intake-rules" || row?.adjudication?.decidedBy === "router" || row?.adjudication?.decidedBy === "adjudicator" ? row.adjudication.decidedBy : null,
            score: row?.score ?? null,
            criteria: (row?.criteria ?? []).map((line) => ({ criterion: line.criterion, verdict: line.verdict })),
            costUsd: Number(cost._sum.costUsd ?? 0),
          });
          console.log(`${item.id} → ${suggestionId}: ${row?.state ?? "gone"}, score ${String(row?.score ?? "none")}, ${row?.outcome ?? "undecided"} by ${row?.adjudication?.decidedBy ?? "nobody"}${item.expected.decision === null ? "" : ` (the arithmetic expected ${item.expected.decision})`}`);
        } catch (error: unknown) {
          console.log(`${item.id}: not run — ${error instanceof Error ? error.message : String(error)}`);
          runItems.push({ id: item.id, suggestionId, decision: null, decidedBy: null, score: null, criteria: [], costUsd: 0 });
        }
        await unthrottled();
      }
    });
    const notRun = runItems.filter((entry) => entry.decision === null).length;
    if (args.grade === "real" && runItems.every((entry) => entry.costUsd === 0)) {
      console.error("the real run made no paid call: nothing is written as a real run. Check the principal's key and the gateway.");
      return 1;
    }

    const run: CuratedRun = { header: { release: release.id, grade: args.grade, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), principal: principalId, costUsd: runItems.reduce((sum, entry) => sum + entry.costUsd, 0) }, items: runItems };
    mkdirSync(REPORTS_DIR, { recursive: true });
    const file = pilot ? curatedRunFileName(release.id, args.grade, startedAt).replace("suggestions-run-", "suggestions-pilot-") : curatedRunFileName(release.id, args.grade, startedAt);
    writeFileSync(join(REPORTS_DIR, file), JSON.stringify(run, null, 2));
    const decided = runItems.filter((entry) => entry.decision !== null).length;
    const asExpected = runItems.filter((entry) => {
      const expected = items.find((item) => item.id === entry.id)?.expected.decision ?? null;
      return expected !== null && entry.decision === expected;
    }).length;
    const byRule = items.filter((item) => item.expected.decision !== null).length;
    console.log(`\n${String(decided)} of ${String(items.length)} decided · ${String(asExpected)} of ${String(byRule)} rule-decided items ended as the arithmetic expected · $${run.header.costUsd.toFixed(3)} · written to ${join(REPORTS_DIR, file)}`);
    if (notRun > 0) console.error(`${String(notRun)} item(s) did not run: the file says so, and the run is a failure.`);
    return notRun > 0 ? 1 : 0;
  } finally {
    for (const end of started.reverse()) await Promise.resolve().then(end).catch((error: unknown) => console.error(error));
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    for (const line of held) console.error(line);
    console.error(error);
    process.exit(1);
  },
);
