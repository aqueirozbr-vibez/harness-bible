import "dotenv/config";

import { format, inspect } from "node:util";

import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";

import { readSuggestionAsService, type SuggestionForService } from "@/lib/db/improve";
import { env } from "@/lib/env";
import { mergeWorkflowId, SUGGESTION_WORKFLOW, suggestionWorkflowId } from "@/lib/schemas/workflows";
import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import { WORKED_EXAMPLES, type WorkedExample } from "@/tests/fixtures/improve/examples";
import { clearExampleSuggestions, draftExample, exampleActivities, mergeWaitingOf, signInContributor, startStubGateway, waitingOf } from "@/tests/fixtures/improve/harness";
import { startTestServer } from "@/tests/workflows/server";
import { bundleWorkflows } from "@/workers/temporal";

/*
 * `npm run improve:seed` (feature-specs/33 § 8; unit 50g): the four worked examples as suggestions in the development
 * database, so that the pages of specs 34 to 36 have something to show before anyone has submitted anything.
 *
 * Each is run as its suite runs it (tests/integration/worked-examples.test.ts): drafted through the endpoints by a
 * development account, then the real workflow on Temporal's test environment, started here, with its real activities on
 * the stub gateway started here and the fixture's documents. No model is asked: the development workers call the real
 * gateway, and an example run on them would be paid calls. It needs the database, the policy sidecar and the test
 * server's file (fetched on first use, or by `npm run workflows:test-server`); not the engine, not the workers.
 *
 * The runs are the seed's own and end with it. A seeded suggestion therefore has no running workflow: a revision of it
 * answers 409, and a curator's decision (53c) finds no run to signal. The accepted example's merge (54b) has no
 * repository of the book, which the seed never writes, and is seeded where it waits: `MERGING`, the reason on its row. Run again, the seed replaces its suggestions with
 * a new set under the same account, which it keeps: a person may sign in as it and use it. Each example's end is
 * checked against § 8's, and one that ends elsewhere fails the seed. Its ledger records stay, as every record does.
 */

const EMAIL = "improve-seed@harness-bible.local";
/* A new address each run, as the suite's, so that a run never meets the limits an earlier one left on its address. */
const ADDRESS = `2001:db8:5e::${Date.now().toString(16)}`;
/* A workflow task that keeps failing is retried for ever: a run that has not ended by then is the seed's failure. */
const RUN_LIMIT_MS = 120_000;

/* What the SDK and the endpoints print — the bundler, the worker, a line per request and per policy decision — held, and shown only if the seed fails. */
const held: string[] = [];
const logger = new DefaultLogger("WARN", (entry) => held.push(`[temporal ${entry.level}] ${entry.message}${entry.meta === undefined ? "" : ` ${inspect(entry.meta, { depth: 4, breakLength: 160 })}`}`));

function within<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not end in ${String(RUN_LIMIT_MS / 1000)} s`)), RUN_LIMIT_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Where the example ended, as its line says it, and whether that is where § 8 says it ends. */
function endOf(example: WorkedExample, row: SuggestionForService | null): { readonly line: string; readonly same: boolean } {
  const ended = `${row?.state ?? "gone"}, score ${String(row?.score ?? "none")}, ${row?.outcome ?? "undecided"} by ${row?.adjudication?.decidedBy ?? "nobody"}`;
  const { ends } = example;
  const expected = `${ends.state}, score ${String(ends.score)}, ${ends.decision} by ${ends.decidedBy}`;
  return ended === expected ? { line: ended, same: true } : { line: `${ended}  ≠ § 8: ${expected}`, same: false };
}

async function main(): Promise<number> {
  /* The store is written and read as the activities do, by key: nothing here signs a URL, so no OBJECT_STORE_SECRET. */
  if (env.DATABASE_URL === undefined || env.OPA_URL === undefined || env.AUTH_DEV_PROVIDER !== "1") {
    console.error("improve:seed writes to the development database: it needs DATABASE_URL, OPA_URL and AUTH_DEV_PROVIDER=1, as .env sets them for development.");
    return 1;
  }
  Runtime.install({ logger, telemetryOptions: { logging: { forward: {} } } });
  console.info = (...args: unknown[]) => void held.push(format(...args));
  /* What was started, ended in reverse whatever fails: a lock left behind stalls the next run that wants it. */
  const started: Array<() => unknown> = [];
  try {
    const stub = await startStubGateway();
    started.push(() => stub.close());
    const server = await startTestServer();
    started.push(() => server.teardown());
    const taskQueue = "improve-seed";
    const worker = await Worker.create({ connection: server.nativeConnection, taskQueue, workflowBundle: await bundleWorkflows(logger), activities: exampleActivities(stub, WORKED_EXAMPLES) });
    /* The lock is the ledger's, which only the runs append to: the test server's first download and the bundle come before it. */
    started.push(await acquire(LEDGER_LOCK));
    await clearExampleSuggestions(EMAIL);
    const contributor = await signInContributor(EMAIL, ADDRESS);
    let elsewhere = 0;
    await worker.runUntil(async () => {
      for (const example of WORKED_EXAMPLES) {
        const id = await draftExample(example, contributor, ADDRESS);
        const handle = await server.client.workflow.start(SUGGESTION_WORKFLOW, { taskQueue, workflowId: suggestionWorkflowId(id), args: [{ suggestionId: id }] });
        if (example.ends.merge !== null) {
          await within(mergeWaitingOf(server.client.workflow.getHandle(mergeWorkflowId(id))), `${id}'s merge`);
          await handle.terminate("the seed's run ends with the seed");
        } else if (example.ends.waits === null) {
          await within(handle.result(), `${id}'s run`);
        } else {
          await waitingOf(handle);
          await handle.terminate("the seed's run ends with the seed");
        }
        const end = endOf(example, await readSuggestionAsService({ kind: "service", id: "service:intake" }, id));
        if (!end.same) elsewhere += 1;
        console.log(`${id}  ${example.name}: ${end.line}`);
      }
    });
    if (elsewhere > 0) {
      console.error(`${String(elsewhere)} of ${String(WORKED_EXAMPLES.length)} examples ended elsewhere than spec 33 § 8 says; each is seeded as it ended. The examples are written for release 2026.09 and rubric v1.2; with those in force, tests/integration/worked-examples.test.ts says more.`);
      return 1;
    }
    console.log(`Seeded as ${EMAIL}. Run again to replace the set.`);
    return 0;
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
