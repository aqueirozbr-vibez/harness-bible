import "dotenv/config";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { format, inspect } from "node:util";

import { DefaultLogger, Runtime } from "@temporalio/worker";

import type { SessionUser } from "@/lib/auth/session";
import { createConversation } from "@/lib/db/assistant";
import { getPrisma } from "@/lib/db/client";
import { readFindings } from "@/lib/db/research";
import { currentRelease } from "@/lib/db/shared";
import { withSystem } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import type { ResearchSkip, ResearchState } from "@/lib/schemas/research";
import { RESEARCH_WORKFLOW, ResearchWorkflowResultSchema, researchWorkflowId } from "@/lib/schemas/workflows";
import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import { clearResearchOf, conversationsAsking, handOverTurn, researchRunActivities, settleSuggestions, startResearchStub } from "@/tests/fixtures/research/harness";
import { seedResearchPage, type ResearchPageSeed } from "@/tests/fixtures/research/page";
import { environmentOf } from "@/tests/workflows/environmentOf";
import { startTestServer } from "@/tests/workflows/server";
import { bundleWorkflows } from "@/workers/temporal";
import { OUTCOMES_EVERY } from "@/workers/research/pace";

/*
 * `npm run research:seed`: what the research screens show on a machine that asks no model, in two parts.
 *
 * **The Research page's states** (feature-specs/48 § 26; unit 72): six researches of the account — done with a
 * follow-up, under way, refused, stopped, purged, seeded — and an Assistant answer to seed one from (`?from=`), with a
 * refusal after it in its conversation (since unit 75: the answer offers `Start a research`, the refusal none), written
 * as rows the way their runs would have left them (tests/fixtures/research/page.ts). No workflow is started, but since
 * unit 73 every run but the rule's refusal carries the workflow id its start would have given it, since the statistics
 * count only runs with one (§ 11.6): so nine of the seed's runs count toward the account's thirty a day, as real ones
 * would, until they are a day old or the seed runs again; the budget's reset the start reads is the newest run's, which
 * met no cap. Run again, the seed also removes the runs a delete of one of its researches detached. The run under way
 * reads as stale 90 minutes after the seed, as any run nothing moves (§ 6): seed again before measuring it.
 *
 * **The Assistant's research lines** (feature-specs/43 § 13.11; unit 60b, part 3): a conversation of the account whose
 * turns show the legacy research line in the states it can show, and under the newest a proposal the researcher made —
 * so that the panel, the landing page's list and the queue have something to show. Since unit 75 no turn is handed to
 * research (feature-specs/48 § 9.2), and these are legacy rows, read as any that stand are (§ 4.3, § 9.3): the line
 * and the panel under their answers, the `off` line with no `switch on`, and beside them each answer's `Start a
 * research`, which the truncation suite measures on this conversation and on the seed answer's. The two runs that make a suggestion are real: the research workflow and the
 * suggestion's on Temporal's test environment, started here, with their real activities on the stub gateway started
 * here and the stub's fixture pages (tests/fixtures/research/harness.ts), as the end-to-end suite runs them. One source
 * graded B is recommended into the curator queue — PROPOSED; one graded G is declined at the floor — REFUTED, for the
 * research log. The other turns' runs are rows written in the state their line shows. No model is asked, and no
 * platform mark is written: a section's or a question's mark, or the budget's, would stop real research on this
 * machine, so the two budget lines are not seeded and a skip's days read `today`. The runs are the seed's own and end
 * with it, as the improve seed's: the proposal has no running workflow, so `Add my name` on it answers 409, which the
 * panel reads as a proposal past taking names.
 *
 * Options: `--page` seeds the first part alone, without the engine's test server, keeping the second's conversation
 * from the last report; `--account <e-mail>` seeds an account that has signed in on this machine other than the demo
 * reader (the page's browser suite seeds its own); `--report <path>` writes the report elsewhere. Run again, the seed
 * replaces what it wrote for the account. Its ledger records stay, as every record does. Where its researches and its
 * conversation are goes to the report, `pipeline/reports/research-seed.json` by default, which the truncation suite
 * reads (tests/layout/pt-truncation.spec.ts).
 */

/** Where the seed says its conversation is, for the truncation suite. */
export const RESEARCH_SEED_REPORT = join("pipeline", "reports", "research-seed.json");

const DEMO = "demo@harness-bible.local";
const TRACE = "5eed".repeat(8);
/** The seed's conversation is known by its first question. */
const FIRST_QUESTION = "Why does a retried write without an idempotency key become a second write?";
const RUN_LIMIT_MS = 120_000;

const held: string[] = [];
const logger = new DefaultLogger("WARN", (entry) => held.push(`[temporal ${entry.level}] ${entry.message}${entry.meta === undefined ? "" : ` ${inspect(entry.meta, { depth: 4, breakLength: 160 })}`}`));

/** The turns whose runs are rows in the state their line shows (43 § 4.2), oldest first. */
const LINES: ReadonlyArray<{ readonly question: string; readonly state: ResearchState; readonly skip?: ResearchSkip; readonly failure?: string }> = [
  { question: FIRST_QUESTION, state: "QUEUED" },
  { question: "How long should a server keep an idempotency key?", state: "READING" },
  { question: "What does a gateway do with a retried request?", state: "SUBMITTING" },
  { question: "Is a retry storm the same as a thundering herd?", state: "DONE" },
  { question: "What makes a planner fail?", state: "FAILED", failure: "PLANNER_FAILED" },
  { question: "Can research be switched off for me?", state: "SKIPPED", skip: "OFF_USER" },
  { question: "Can my organisation switch research off?", state: "SKIPPED", skip: "OFF_ORGANISATION" },
  { question: "What is a section with nothing cited?", state: "SKIPPED", skip: "NO_CITATION" },
  { question: "Were these sections researched lately?", state: "SKIPPED", skip: "DEDUPED" },
  { question: "Was this question researched lately?", state: "SKIPPED", skip: "SAME_QUESTION" },
  { question: "How many runs does a day take?", state: "SKIPPED", skip: "DAILY_LIMIT" },
  { question: "What if the book already covers it?", state: "SKIPPED", skip: "NOTHING_TO_RESEARCH" },
  { question: "What if research is not configured?", state: "SKIPPED", skip: "UNAVAILABLE" },
];

function within<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not end in ${String(RUN_LIMIT_MS / 1000)} s`)), RUN_LIMIT_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** What the report holds: the account, the Assistant conversation of the second part, the researches of the first. */
interface SeedReport {
  readonly account: string;
  readonly conversationId: string | null;
  readonly research: ResearchPageSeed;
  readonly seededAt: string;
}

interface Options {
  readonly account: string;
  readonly pageOnly: boolean;
  readonly report: string;
}

function optionsOf(argv: ReadonlyArray<string>): Options {
  const valueOf = (name: string): string | null => {
    const at = argv.indexOf(name);
    return at === -1 ? null : (argv[at + 1] ?? null);
  };
  return { account: valueOf("--account") ?? DEMO, pageOnly: argv.includes("--page"), report: valueOf("--report") ?? RESEARCH_SEED_REPORT };
}

/** The Assistant's research lines (43 § 13.11): the conversation, its legacy runs, and the two real runs on the test server. */
async function seedLegacy(asker: SessionUser): Promise<string> {
  Runtime.install({ logger, telemetryOptions: { logging: { forward: {} } } });
  console.info = (...args: unknown[]) => void held.push(format(...args));
  const started: Array<() => unknown> = [];
  try {
    const stub = await startResearchStub();
    started.push(() => stub.close());
    const server = await startTestServer();
    started.push(() => server.teardown());
    const environment = environmentOf(server, await bundleWorkflows(logger));
    /* the runs append the ledger's records: the chain is held while they do (tests/fixtures/exclusive.ts) */
    started.push(await acquire(LEDGER_LOCK));

    /* the seed's earlier conversation, and the suggestions its runs made */
    const earlier = await conversationsAsking(asker, FIRST_QUESTION, TRACE);
    if (earlier.length > 0) await clearResearchOf(asker, earlier, TRACE);

    const release = await currentRelease();
    /* the third and fourth mechanism sections: the end-to-end suite's runs cite the first two with the same stub claim, and a proposal made twice at one text is a duplicate (42 § 4.3) */
    const sections = await getPrisma().section.findMany({ where: { chapterVersion: { releaseId: release.id }, layer: "MECHANISM" }, orderBy: [{ chapterVersion: { chapterNumber: "asc" } }, { ordinal: "asc" }], select: { anchor: true }, skip: 2, take: 2 });
    const [cited, refutedAt] = [sections[0]?.anchor, sections[1]?.anchor ?? sections[0]?.anchor];
    if (cited === undefined || refutedAt === undefined) throw new Error(`release ${release.id} has no mechanism section to cite`);

    const conversation = await createConversation(asker, { locale: "en" });
    let ordinal = 0;
    for (const line of LINES) {
      ordinal += 2;
      await handOverTurn(asker, conversation.id, { question: line.question, cited, releaseId: release.id, ordinal, traceId: TRACE, state: line.state, skip: line.skip ?? null, failure: line.failure ?? null });
    }

    /* the two real runs, the refuted one first so the proposal is the newest turn */
    const runs: Array<{ readonly question: string; readonly cited: string; readonly grade: string; readonly expected: string }> = [
      { question: "How is a retry storm after a deploy contained?", cited: refutedAt, grade: "G", expected: "REFUTED" },
      { question: "How long must a server keep the key that makes a retried write safe?", cited, grade: "B:direct:none", expected: "PROPOSED" },
    ];
    for (const run of runs) {
      ordinal += 2;
      const handed = await handOverTurn(asker, conversation.id, { question: run.question, cited: run.cited, releaseId: release.id, ordinal, traceId: TRACE });
      const ended = await environment.withWorker(researchRunActivities(stub, {}, run.grade), async (taskQueue) => {
        const handle = await environment.client.workflow.start(RESEARCH_WORKFLOW, { taskQueue, workflowId: researchWorkflowId(handed.messageId), args: [{ runId: handed.runId, userId: asker.id }] });
        const result = ResearchWorkflowResultSchema.parse(await within(environment.resultOf(handle, OUTCOMES_EVERY), `the run of ${handed.messageId}`));
        await settleSuggestions(environment.client, asker, handed.runId);
        return result;
      });
      const findings = await readFindings({ id: handed.runId, userId: asker.id });
      const outcome = findings[0]?.outcome ?? "none";
      console.log(`${ended.state}  ${findings[0]?.suggestionId ?? "no suggestion"}  ${outcome}${outcome === run.expected ? "" : `  ≠ ${run.expected}`}`);
      if (outcome !== run.expected) throw new Error(`the run of "${run.question}" ended ${outcome}, not ${run.expected}`);
    }
    return conversation.id;
  } finally {
    for (const end of started.reverse()) await Promise.resolve().then(end).catch((error: unknown) => console.error(error));
  }
}

/** The last report's Assistant conversation, kept by a `--page` run for the same account. */
function previousConversation(report: string, account: string): string | null {
  if (!existsSync(report)) return null;
  const previous = JSON.parse(readFileSync(report, "utf8")) as { account?: unknown; conversationId?: unknown };
  return previous.account === account && typeof previous.conversationId === "string" ? previous.conversationId : null;
}

async function main(): Promise<number> {
  if (env.DATABASE_URL === undefined) {
    console.error("research:seed writes to the development database: it needs DATABASE_URL, as .env sets it for development.");
    return 1;
  }
  const options = optionsOf(process.argv.slice(2));
  const row = await withSystem(() => getPrisma().user.findFirst({ where: { email: options.account, deletedAt: null }, select: { id: true, organisationId: true, role: true, displayName: true, identityVerified: true } }));
  if (row === null) {
    console.error(`research:seed writes for ${options.account}, who has not signed in on this machine: sign in once as that account, then run it again.`);
    return 1;
  }
  const asker: SessionUser = { id: row.id, organisationId: row.organisationId, role: row.role, displayName: row.displayName, locale: "en", identityVerified: row.identityVerified, parts: [], sessionId: null };

  const conversationId = options.pageOnly ? previousConversation(options.report, options.account) : await seedLegacy(asker);
  const research = await seedResearchPage(asker);
  const report: SeedReport = { account: options.account, conversationId, research, seededAt: new Date().toISOString() };
  mkdirSync(dirname(options.report), { recursive: true });
  writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  if (conversationId !== null) console.log(`Seeded for ${options.account}: /en/assistant?ask=${conversationId}`);
  console.log(`Seeded for ${options.account}: /en/research?research=${research.done} (done) · ${research.underWay} (under way) · ${research.refused} (refused) · ${research.stopped} (stopped) · ${research.purged} (purged) · ${research.seeded} (seeded); /en/research?from=${research.seedAnswer}; its answer, and a refusal, at /en/assistant?ask=${research.seedConversation}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    for (const line of held) console.error(line);
    console.error(error);
    process.exit(1);
  },
);
