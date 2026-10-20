import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { resolveDevUser } from "@/lib/auth/link";
import type { SessionUser } from "@/lib/auth/session";
import { monthOf, monthSpend, tenantOfPrincipal, tokenCapOf } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { estimateOf, newestRun, REPORTS_DIR, runFileName, runGolden, writeRunFile } from "@/lib/gate/goldenRun";
import { citationRate } from "@/lib/gate/phase2";
import { maxBudgetUsd } from "@/lib/gateway/prices";
import { GoldenItemSchema, type GoldenItem } from "@/lib/schemas/golden";
import type { Principal } from "@/lib/schemas/gateway";
import { GoldenRunHeaderSchema, type GoldenRunHeader, type GoldenRunItem, type RunGrade } from "@/lib/schemas/goldenRun";
import { defaultWorkersDeps, ROUTE_TIMEOUT_MS, type WorkersClientDeps } from "@/lib/workers/client";
import { clearConversations, goldenDeps, principalOf, sessionOf } from "@/workers/gate/goldenDeps";
import { startStubStack, type StubStack } from "@/workers/gate/stubStack";

/*
 * npm run gate:golden (feature-specs/22 § 4): the golden set through the workers, one line per item into
 * pipeline/reports/. The gate (`npm run gate:phase2`) reads the newest file of each grade; this command is what
 * writes them, because a run is slow or costs money and a gate should be rerunnable without either.
 *
 *   npm run gate:golden -- --stub                       the workers and the stub gateway in this process; no key, no cost
 *   npm run gate:golden -- --real --user <e-mail>        prints what the run would cost and what the account's cap covers, and stops
 *   npm run gate:golden -- --real --user <e-mail> --yes  runs it through the running workers and the provider
 *   … --limit <n>                                        the first n items: a pilot before the whole set, in a file of its own
 *
 * The real grade spends the named account's model budget (its organisation's, or its own): name an account whose cap
 * covers the estimate, or the gateway will refuse mid-run and the file will say `partial` (§ 7). The stub grade
 * writes its conversations as `gate-stub@harness-bible.local` and replaces that account's previous run; the real
 * grade's conversations stay, because a curator's label names the answers in them.
 */

const STUB_ACCOUNT = "gate-stub@harness-bible.local";
/** Items in flight at once (§ 4): the provider's side is rate-limited, the stub's is not. */
const CONCURRENCY: Readonly<Record<RunGrade, number>> = { real: 2, stub: 8 };

function usage(message: string): never {
  console.error(`${message}\nusage: npm run gate:golden -- --stub | --real --user <e-mail> [--yes] [--limit <n>]`);
  process.exit(1);
}

async function accountOf(email: string): Promise<SessionUser> {
  const found = await withSystem(() => getPrisma().user.findUnique({ where: { email }, select: { id: true, organisationId: true } }));
  if (found === null) usage(`no account ${email}: the real grade runs as an existing account, whose budget it spends`);
  return sessionOf(found.id, found.organisationId);
}

/** The principal's paid turns of the last thirty days, a cost each: one of the things an estimate is made from. */
async function paidTurns(principal: Principal): Promise<ReadonlyArray<number>> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const turns = await withTenant(tenantOfPrincipal(principal), () =>
    getPrisma().budgetLedger.groupBy({ by: ["traceId"], where: { createdAt: { gte: since }, outcome: "ok", kind: { in: ["ASSISTANT", "GRADING"] } }, _sum: { costUsd: true } }),
  );
  return turns.map((turn) => Number(turn._sum.costUsd ?? 0));
}

/**
 * What the account's cap still covers this month, in the unit the gateway enforces: the cap's tokens as dollars at
 * the frontier input price (feature-specs/11 D3), less the month's rows. A run the cap cannot cover is refused
 * part-way (§ 7), so the command says so before anything is spent.
 */
async function headroom(principal: Principal, estimateUsd: number | null): Promise<string> {
  const cap = await tokenCapOf(principal, env.INDIVIDUAL_TOKEN_CAP === undefined ? null : Number(env.INDIVIDUAL_TOKEN_CAP));
  if (cap === null) return "this account has no cap set, so the gateway holds no key for it and would refuse the first turn";
  const capUsd = maxBudgetUsd(BigInt(cap));
  const spent = Number((await monthSpend(principal, monthOf(new Date()))).costUsd);
  const left = Math.max(0, capUsd - spent);
  const verdict = estimateUsd === null ? "" : estimateUsd > left ? ": less than the estimate, so the gateway would refuse part-way and the file would say partial. Raise the cap, or name an account whose cap covers the run" : ": enough for the estimate";
  return `this account's cap is $${capUsd.toFixed(2)} a month and its ledger rows of the month come to $${spent.toFixed(2)}, which leaves $${left.toFixed(2)}${verdict}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { stub: { type: "boolean", default: false }, real: { type: "boolean", default: false }, user: { type: "string" }, yes: { type: "boolean", default: false }, limit: { type: "string" } }, strict: true });
  if (values.stub === values.real) usage("say which grade: --stub or --real");
  const grade: RunGrade = values.real ? "real" : "stub";
  const limit = values.limit === undefined ? null : Number(values.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) usage(`--limit takes a whole number of items, not ${values.limit ?? ""}`);

  const release = await getPrisma().release.findFirst({ where: { isCurrent: true }, select: { id: true } });
  if (release === null) throw new Error("no current release: run `npm run ingest`");
  const golden = readFileSync(join(process.cwd(), "golden", "assistant", `${release.id}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => GoldenItemSchema.parse(JSON.parse(line)));
  const items: ReadonlyArray<GoldenItem> = limit === null ? golden : golden.slice(0, limit);

  let user: SessionUser;
  let stack: StubStack | null = null;
  let workers: WorkersClientDeps;
  if (grade === "stub") {
    const account = await resolveDevUser(STUB_ACCOUNT, "en");
    user = sessionOf(account.userId, account.organisationId);
    /* The stub account's rows of an earlier run are replaced, so that a stub run leaves one run's worth behind and not
       many. A pilot replaces nothing: the run's rows are what `gate:show` reads, and a few more are no burden. */
    const cleared = limit === null ? await clearConversations(user) : 0;
    if (cleared > 0) console.log(`replacing the stub account's earlier run: ${String(cleared)} conversation(s) removed`);
    stack = await startStubStack();
    workers = { baseUrl: stack.url, token: stack.token, fetch: globalThis.fetch, timeouts: ROUTE_TIMEOUT_MS };
  } else {
    if (values.user === undefined) usage("--real needs --user <e-mail>: the account the run asks as, and whose budget it spends");
    user = await accountOf(values.user);
    workers = defaultWorkersDeps();
  }
  const principal: Principal = principalOf(user);

  if (grade === "real") {
    const cost = estimateOf(items.length, { real: newestRun(REPORTS_DIR, release.id, "real"), stub: newestRun(REPORTS_DIR, release.id, "stub"), paidTurns: await paidTurns(principal) });
    console.log(`gate:golden · real · ${String(items.length)} items · ${cost.text}`);
    console.log(`  ${await headroom(principal, cost.usd)}`);
    if (!values.yes) {
      console.log("Nothing was run. Add --yes to run it: every item is a paid turn through the provider.");
      return;
    }
  }

  const startedAt = new Date();
  const name = runFileName(release.id, grade, startedAt, limit !== null);
  const header = (partial: boolean): GoldenRunHeader => GoldenRunHeaderSchema.parse({ run: "golden", release: release.id, grade, startedAt: startedAt.toISOString(), userId: user.id, partial });
  const done: GoldenRunItem[] = [];

  const deps = goldenDeps({ user, workers, stack });

  /* The turns in this process print their own lines and warnings (a retrieval, an answer, a repair); they are the
     workers' log, not this command's output, and what they report is in the run file. */
  const { info, warn } = console;
  if (stack !== null) {
    console.info = () => undefined;
    console.warn = () => undefined;
  }
  let result: Awaited<ReturnType<typeof runGolden>>;
  try {
    result = await runGolden(
      items,
      {
        concurrency: CONCURRENCY[grade],
        onRecord: (record, count) => {
          done.push(record);
          /* The file is rewritten as the run goes and says `partial` until the last item: a run that dies leaves what it had. */
          writeRunFile(REPORTS_DIR, name, header(true), done);
          if (count % 25 === 0 || count === items.length) console.log(`  ${String(count)}/${String(items.length)}`);
        },
      },
      deps,
    );
  } finally {
    console.info = info;
    console.warn = warn;
    await stack?.close();
  }

  const path = writeRunFile(REPORTS_DIR, name, header(result.partial || limit !== null), result.records);
  const rate = citationRate(result.records);
  const by = (outcome: GoldenRunItem["outcome"]) => result.records.filter((record) => record.outcome === outcome).length;
  const cost = result.records.reduce((sum, record) => sum + record.costUsd, 0);
  console.log(`gate:golden · ${grade} · ${String(result.records.length)}/${String(items.length)} items in ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)} s · ${String(by("answer"))} answered, ${String(by("refusal"))} refused, ${String(by("failed"))} failed`);
  console.log(`  cited on every claim ${String(rate.cited)}/${String(rate.items)} · refusals with the expected cause ${String(rate.refusals.correct)}/${String(rate.refusals.items)} · the label's citations found in ${String(result.records.filter((record) => record.expectedHit).length)}/${String(result.records.length)}`);
  const spent = grade === "real" ? `cost $${cost.toFixed(4)}` : `nothing was paid; the same prompts priced by prices.ts come to $${cost.toFixed(2)}`;
  console.log(`  ${spent}${result.partial ? " · PARTIAL: the run stopped before the last item" : limit !== null ? " · a pilot of the first items: its file is kept apart from the runs the gate reads" : ""}`);
  console.log(`  ${path}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
