import "dotenv/config";

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findAid, loadAids } from "@/lib/aids/index";
import { getPrisma } from "@/lib/db/client";
import { head, range, recordsAt, toChainRecord } from "@/lib/db/ledger";
import { env } from "@/lib/env";
import { startGateApi, type GateApi } from "@/lib/gate/api";
import { formatGateReport } from "@/lib/gate/common";
import { newestRun, REPORTS_DIR } from "@/lib/gate/goldenRun";
import { LABELS_DIR, labelsFileName, readLabels } from "@/lib/gate/labels";
import { measureFlag, measureRefusals, measureRetention, measureSubstitution, measureWalk } from "@/lib/gate/measure";
import { ledgerCheckOf, phase2Report, pickRefusalItems, type GoldenRun, type LedgerCheck, type Phase2Facts, type Unmeasured, type WalkCheck } from "@/lib/gate/phase2";
import { refusedUnverified, walkFactOf, walkShape, type WalkOutcome } from "@/lib/gate/walk";
import { verifyChain } from "@/lib/ledger/verify";
import { GoldenItemSchema, type GoldenItem } from "@/lib/schemas/golden";
import { ROUTE_TIMEOUT_MS } from "@/lib/workers/client";
import { clearConversations } from "@/workers/gate/goldenDeps";
import { startStubStack } from "@/workers/gate/stubStack";

/*
 * npm run gate:phase2 — the Phase 2 gate report (project-overview § Success criteria · Phase 2; feature-specs/22).
 * Ten criteria for the overview's seven promises. Four are read from the golden run's files and the curator's
 * labels (`npm run gate:golden` writes the files, a person writes the labels); one is read from the ledger; five
 * are the gate's own turns through the API. Writes pipeline/reports/phase2-gate-<release>.json and exits 1 unless
 * every criterion passes.
 *
 * The gate never pays: it reads what a run left behind, and its own turns go to workers over the stub gateway, both
 * started in this process (workers/gate/stubStack.ts), through the API's endpoints with a signed-in reader
 * (lib/gate/api.ts). So it needs the database and the policy sidecar, and nothing else that is running. A criterion
 * that needs a provider's answers is `blocked` until a whole real run exists, with the stub run's numbers in its
 * note as shape only. A pilot is not a run (lib/gate/goldenRun.ts `runFileName`).
 *
 * Its own turns are asked as `gate-check@harness-bible.local`, whose conversations of the previous gate are
 * replaced. Their ledger records stay, as every record does: eight a run on this release. The purge of P2.6b runs
 * with its clock 31 days ahead and is kept to that one reader, so no other conversation loses a word to the gate.
 *
 * The walk of P2.4 runs the release's script as the lab tier runs it (`AID_RUNNER`: a container by default), so it
 * needs Docker; without it the criterion is `blocked`, as it is when the release has not verified the aid's chapter.
 *
 * Built in units 36c-1 (the report, P2.1a, P2.1b, P2.5a, P2.5b, P2.7), 36c-2 (P2.2, P2.3), 36c-3 (P2.6a, P2.6b)
 * and 36c-4 (P2.4). No criterion is `deferred` any more.
 */

const GATE_ACCOUNT = "gate-check@harness-bible.local";
/** The walk the overview's criterion (4) names: 37.8, which configuration. */
const WALK_AID = "37.8-which-configuration";

/** The policy sidecar answers its health route. Without it every request is denied, and a denied request measures nothing. */
async function policyUp(): Promise<boolean> {
  if (env.OPA_URL === undefined) return false;
  try {
    const response = await fetch(`${env.OPA_URL.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * P2.7: every answer of the run against the record at its `ledgerSeq`, and the chain from genesis to its head. The
 * whole chain is read into memory, which a development chain allows; a production gate would verify it by ranges.
 */
async function ledgerFact(run: GoldenRun | null): Promise<LedgerCheck | Unmeasured> {
  if (run === null) return { blocked: "No golden run to check against the ledger: `npm run gate:golden -- --stub` writes one without a key." };
  const top = await head();
  const chain = top === null ? { ok: false, records: 0, firstBreak: null } : verifyChain((await range(1, top.seq)).map(toChainRecord), { expectHead: top.hash });
  const seqs = run.items.flatMap((item) => (item.outcome === "answer" && item.ledgerSeq !== null ? [item.ledgerSeq] : []));
  const rows = await recordsAt(seqs);
  return ledgerCheckOf(
    run,
    rows.map((row) => ({ seq: row.seq, kind: row.kind, payload: row.payload })),
    chain,
  );
}

/** The release's own run of a lab: its `results/derived.json`, as the pipeline ingested it with the release. */
async function releaseResultsOf(releaseId: string, labId: string): Promise<unknown> {
  const lab = await getPrisma().lab.findFirst({ where: { anchor: labId, chapterVersion: { releaseId } }, select: { derived: true } });
  return lab?.derived ?? null;
}

/** A walk's script failed and it runs in a container: whether the container runtime answers at all. Asked only then. */
function containerDown(outcome: WalkOutcome): boolean {
  if (outcome.kind !== "failed" || env.AID_RUNNER !== "docker") return false;
  return spawnSync(env.DOCKER_BIN, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 15_000 }).status !== 0;
}

/**
 * P2.4: the 37.8 walk at the book's inputs. When the release has not verified chapter 37 the walk refuses, and the
 * first aid of a verified chapter is walked beside it, as shape only.
 */
async function walkFact(api: GateApi, releaseId: string, verified: ReadonlySet<number>): Promise<WalkCheck | Unmeasured> {
  const aid = findAid(WALK_AID);
  if (aid === null) return { blocked: `aids/ holds no ${WALK_AID}: the walk the criterion names is not defined in this repository.` };
  const releaseResults = await releaseResultsOf(releaseId, aid.labId);
  const outcome = await measureWalk(api, aid, releaseResults);
  const chapterVerified = verified.has(aid.chapter);
  let shape: string | null = null;
  if (refusedUnverified({ outcome, chapterVerified })) {
    const other = loadAids().find((candidate) => verified.has(candidate.chapter));
    if (other === undefined) shape = "There is no aid of a verified chapter to walk beside it as shape.";
    else {
      const walked = await measureWalk(api, other, await releaseResultsOf(releaseId, other.labId));
      shape = walkShape(other, walked, containerDown(walked));
    }
  }
  return walkFactOf({ aid, release: releaseId, chapterVerified, outcome, containerDown: containerDown(outcome), releaseResults, shape });
}

/** The gate's own turns: the stub stack and the API in this process, the questions asked, everything closed again. */
async function ownTurns(golden: ReadonlyArray<GoldenItem>, releaseId: string, verified: ReadonlySet<number>): Promise<Pick<Phase2Facts, "refusals" | "substitution" | "walk" | "flag" | "retention">> {
  const claim = golden.find((item) => item.kind === "claim" && verified.has(item.context.chapter));
  const stack = await startStubStack();
  /* The turns in this process print their own lines (a request, a retrieval, an answer); they are the product's log, not this report. */
  const { info, warn } = console;
  console.info = () => undefined;
  console.warn = () => undefined;
  try {
    const api = await startGateApi({ baseUrl: stack.url, token: stack.token, fetch: globalThis.fetch, timeouts: ROUTE_TIMEOUT_MS }, GATE_ACCOUNT);
    try {
      await clearConversations(api.user);
      const refusals = await measureRefusals(api, stack, pickRefusalItems(golden, verified));
      const walk = await walkFact(api, releaseId, verified);
      if (claim === undefined) {
        const none: Unmeasured = { blocked: "The golden set has no claim question in a verified chapter for the gate to ask." };
        return { refusals, substitution: none, walk, flag: none, retention: none };
      }
      const substitution = await measureSubstitution(api, stack, claim);
      const flagged = await measureFlag(api, claim);
      /* Last, because it takes the words of every conversation the gate has: the purge is watched on the flagged answer. */
      const retention = flagged.answer === null ? { blocked: "The turn asked for P2.6a did not answer, so there is no answer of the gate's own to watch the purge on." } : await measureRetention(api, flagged.answer);
      return { refusals, substitution, walk, flag: flagged.check, retention };
    } finally {
      await api.close();
    }
  } finally {
    console.info = info;
    console.warn = warn;
    await stack.close();
  }
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  /* What the gate needs is checked before any criterion, and a gate that cannot measure writes no report (§ 7). */
  const release = await getPrisma().release.findFirst({ where: { isCurrent: true }, select: { id: true } });
  if (release === null) {
    console.error("gate:phase2: the database holds no current release; run `npm run ingest`.");
    return 1;
  }
  if (!(await policyUp())) {
    console.error(`gate:phase2: the policy sidecar does not answer at ${env.OPA_URL ?? "OPA_URL (unset)"}. Every request through the API would be denied, so nothing could be measured. Start it (npm run policy:serve) and run the gate again.`);
    return 1;
  }
  const golden = readFileSync(join(process.cwd(), "golden", "assistant", `${release.id}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => GoldenItemSchema.parse(JSON.parse(line)));
  const verified = new Set((await getPrisma().chapterVersion.findMany({ where: { releaseId: release.id, verifyStatus: "PASSED" }, select: { chapterNumber: true } })).map((row) => row.chapterNumber));

  const real = newestRun(REPORTS_DIR, release.id, "real");
  const stub = newestRun(REPORTS_DIR, release.id, "stub");
  const labels = readLabels(LABELS_DIR, release.id);

  const turns = await ownTurns(golden, release.id, verified);
  const facts: Phase2Facts = {
    refusals: turns.refusals,
    substitution: turns.substitution,
    walk: turns.walk,
    flag: turns.flag,
    retention: turns.retention,
    /* After the gate's own turns, so the chain that is verified includes the records they wrote. */
    ledger: await ledgerFact(real ?? stub),
  };

  const report = phase2Report({ release: release.id, appUrl: env.APP_URL.replace(/\/$/, ""), real, stub, labels, facts, startedAt, finishedAt: new Date().toISOString() });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const out = join(REPORTS_DIR, `phase2-gate-${release.id}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));

  console.log(formatGateReport(report));
  console.log("");
  console.log(report.run === null ? "golden run: none" : `golden run: ${report.run.file} · ${report.gateway} · ${String(report.run.items)} items · charged $${report.run.cost_usd.toFixed(2)}`);
  console.log(`labels: ${String(labels.length)} in golden/assistant/labels/${labelsFileName(release.id)}`);
  console.log(`report written to ${out}`);
  return report.met ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`gate:phase2: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
