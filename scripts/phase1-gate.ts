import "dotenv/config";

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { getPrisma } from "@/lib/db/client";
import { withSystem } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { bareNumbers, flowsCriterion, formatGateReport, gateVerdict, peekCriterion, percentile, resumeCriterion, truncationCriterion, type Criterion, type GateReport } from "@/lib/gate/phase1";
import { E2eReportSchema, e2eReportName, type E2eReport } from "@/lib/schemas/e2e";
import { TruncationReportSchema, truncationReportName, type TruncationReport } from "@/lib/schemas/layout";
import { EMPTY_FILTERS } from "@/lib/search/filters";
import { searchRelease } from "@/lib/search/hybrid";

/*
 * npm run gate:phase1 — the Phase 1 gate report (project-overview § Success
 * criteria · Phase 1). Reads the current release, recomputes the render hash
 * from the book checkout (the pipeline's dry run), crawls every section page
 * in EN and PT on the running server (APP_URL), samples the derive endpoint,
 * times the search statement and counts the accounts that signed in through
 * SSO. Writes pipeline/reports/phase1-gate-<release>.json and exits 1 unless
 * every criterion passes. P1.8 is read from the report `npm run test:layout`
 * writes. Criteria a later unit measures are `deferred`;
 * criteria that need the book, CI or real accounts are `blocked`.
 */

const CHAPTERS = 41; // project-overview § Success criteria: "any of the 41 chapters", "41/41 chapters passing VERIFY"
const PILOT_ACCOUNTS = 20; // "20 pilot accounts are onboarded via SSO"
const RSC_MAX_BYTES = 150 * 1024; // "an RSC payload under 150 KB per chapter"
const SEARCH_P95_MS = 500; // "results in under 500 ms at p95"
const CITED_TIERS = ["PRIMARY", "VENDOR", "ANALYST", "PRACTITIONER"] as const;
/* the integration suite's 20 varied queries (tests/integration/search.test.ts), so both measure the same vocabulary */
const QUERIES = ["idempotency", "workflow", "retry", "token", "attention", "sensor", "budget", "Temporal", "embedding", "regulation", "evaluation", "cache", "quantization", "memory", "audit", "gateway", "backoff", "approval", "timeout", "lab"];
/* the public API allows 120 reads a minute per address, so the derive endpoint is sampled, not crawled */
const DERIVE_SAMPLE = 20;
const CRAWL_CONCURRENCY = 4;

const app = env.APP_URL.replace(/\/$/, "");
const pad = (n: number): string => String(n).padStart(2, "0");
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${app}/en`, { redirect: "manual" });
    return r.status < 500;
  } catch {
    return false;
  }
}

interface Fetched {
  readonly url: string;
  readonly status: number;
  readonly bytes: number;
  readonly ms: number;
}

async function timedFetch(url: string, headers: Record<string, string> = {}): Promise<Fetched> {
  const started = performance.now();
  try {
    /* redirects are followed: an RSC request answers 307 to the same page with `?_rsc=` */
    const r = await fetch(url, { headers });
    const body = await r.arrayBuffer();
    return { url, status: r.status, bytes: body.byteLength, ms: performance.now() - started };
  } catch {
    return { url, status: 0, bytes: 0, ms: performance.now() - started };
  }
}

async function crawl(urls: ReadonlyArray<string>, headers: Record<string, string> = {}): Promise<Fetched[]> {
  const out: Fetched[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < urls.length) {
      const url = urls[next];
      next += 1;
      out.push(await timedFetch(url, headers));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CRAWL_CONCURRENCY, urls.length) }, worker));
  return out;
}

/** The pipeline's dry run over the book checkout; its report carries the recomputed render hash. */
function recomputeRenderHash(release: string): { readonly hash: string | null; readonly note: string } {
  const bookDir = resolve(env.BOOK_DIR);
  if (!existsSync(join(bookDir, "book"))) return { hash: null, note: `no book checkout at ${bookDir} (BOOK_DIR)` };
  const run = spawnSync(`npm run ingest -- --dry-run --skip-invalid --no-mermaid --release ${release}`, { shell: true, encoding: "utf8", env: { ...process.env, PIPELINE: "1" } });
  if (run.status !== 0) return { hash: null, note: `the pipeline dry run failed (exit ${run.status}): ${(run.stderr ?? "").trim().split("\n").slice(-1)[0] ?? ""}` };
  const path = join("pipeline", "reports", `${release}.dry-run.json`);
  const report = JSON.parse(readFileSync(path, "utf8")) as { renderHash: string; chapters: unknown[] };
  return { hash: report.renderHash, note: `recomputed by \`npm run ingest -- --dry-run\` over ${report.chapters.length} chapters at ${bookDir}` };
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const prisma = getPrisma();
  const release = await prisma.release.findFirst({ where: { isCurrent: true } });
  if (release === null) {
    console.error("gate:phase1: the database holds no current release; run `npm run ingest`.");
    return 1;
  }
  const inRelease = { chapterVersion: { releaseId: release.id } };
  const criteria: Criterion[] = [];

  /* P1.1 · every chapter and section, in EN and PT, and the render hash */
  const chapters = await prisma.chapterVersion.findMany({ where: { releaseId: release.id }, select: { chapterNumber: true, verifyStatus: true, lab: { select: { ciVerdict: true } } }, orderBy: { chapterNumber: "asc" } });
  const sections = await prisma.section.findMany({ where: inRelease, select: { anchor: true, htmlEn: true, chapterVersion: { select: { chapterNumber: true } } }, orderBy: [{ chapterVersion: { chapterNumber: "asc" } }, { ordinal: "asc" }] });
  const up = await serverUp();
  const pages = up ? await crawl(sections.flatMap((s) => ["en", "pt"].map((l) => `${app}/${l}/ch/${pad(s.chapterVersion.chapterNumber)}/${s.anchor}`))) : [];
  const notOk = pages.filter((p) => p.status !== 200);
  const recomputed = recomputeRenderHash(release.id);
  const hashMatchesBook = recomputed.hash === release.renderHash;
  const expected = env.RENDER_HASH_EXPECTED ?? null;
  const hashMatchesCi = expected === null ? null : expected === release.renderHash;
  const pagesNote = up ? `${pages.length} section pages fetched (${sections.length} sections × EN and PT) at ${app}; p95 ${Math.round(percentile(pages.map((p) => p.ms), 95))} ms single-user on this server${notOk.length > 0 ? `; not 200: ${notOk.slice(0, 5).map((p) => `${p.url.replace(app, "")} ${p.status}`).join(", ")}` : ""}` : `server not reachable at ${app}: the page crawl did not run`;
  criteria.push({
    id: "P1.1",
    text: "Every one of the 41 chapters opens at /[lang]/ch/[n]/[section] in EN and PT, and the rendered content hash equals the release's renderHash computed by CI.",
    status: chapters.length === CHAPTERS && up && notOk.length === 0 && hashMatchesBook ? (hashMatchesCi === false ? "fail" : hashMatchesCi === null ? "blocked" : "pass") : "fail",
    measured: `${chapters.length}/${CHAPTERS} chapters · ${up ? `${pages.length - notOk.length}/${pages.length} pages 200` : "pages not crawled"} · stored ${release.renderHash.slice(0, 12)}… ${hashMatchesBook ? "equals" : "DIFFERS from"} the book's ${recomputed.hash?.slice(0, 12) ?? "—"}… · CI value ${expected === null ? "not set" : hashMatchesCi ? "equal" : "DIFFERS"}`,
    note: `${pagesNote}. ${recomputed.note}. ${expected === null ? "RENDER_HASH_EXPECTED is unset: CI does not compute the hash yet (unit 23f; the book is outside this repository)" : "RENDER_HASH_EXPECTED compared"}.`,
  });

  /* P1.2 · VERIFY 41/41 and the Book Home counts */
  const verified = chapters.filter((c) => c.verifyStatus === "PASSED").length;
  const labs = chapters.filter((c) => c.lab !== null).length;
  const reproduced = chapters.filter((c) => c.lab?.ciVerdict === "REPRODUCED").length;
  criteria.push({
    id: "P1.2",
    text: "The book is at 41/41 chapters passing VERIFY; the Book Home instrument shows the same counts as the CI nightly check.",
    /* blocked either way until the book's nightly check exists to compare with; the verify shortfall is the book's, not the application's */
    status: "blocked",
    measured: `verify ${verified}/${CHAPTERS} · labs ${reproduced}/${labs} reproduced`,
    note: `ChapterVersion.verifyStatus and Lab.ciVerdict of release ${release.id}, the rows Book Home renders. ${verified < CHAPTERS ? `${CHAPTERS - verified} chapters are not verified in the book (Open Questions: book readiness; Part III stubs)` : "every chapter verified"}; there is no CI nightly check to compare with yet (the lab matrix runs in the book repository).`,
  });

  /* P1.3 · figures: derived resolve, cited link to a row, illustrative carry the chip, no bare numbers */
  const tiers = await prisma.figure.groupBy({ by: ["tier"], where: { section: inRelease }, _count: { _all: true } });
  const count = (tier: string): number => tiers.find((t) => t.tier === tier)?._count._all ?? 0;
  const derivedUnlinked = await prisma.figure.count({ where: { section: inRelease, tier: "DERIVED", derive: null } });
  const citedWithoutRow = await prisma.figure.count({ where: { section: inRelease, tier: { in: [...CITED_TIERS] }, sourceRowId: null } });
  const illustrative = count("ILLUSTRATIVE");
  const illChips = sections.reduce((n, s) => n + (s.htmlEn.match(/class="fig-ill"/g)?.length ?? 0), 0);
  const open = count("OPEN");
  const bare = sections.flatMap((s) => bareNumbers(s.htmlEn).map((b) => ({ section: s.anchor, ...b })));
  const sample = await prisma.figure.findMany({ where: { section: inRelease, tier: "DERIVED" }, select: { anchor: true }, orderBy: { anchor: "asc" }, take: DERIVE_SAMPLE });
  const derive = up ? await crawl(sample.map((f) => `${app}/api/v1/figures/${encodeURIComponent(f.anchor)}/derive`)) : [];
  const deriveOk = derive.filter((d) => d.status === 200).length;
  const figuresPass = derivedUnlinked === 0 && open === 0 && citedWithoutRow === 0 && illChips === illustrative && bare.length === 0 && up && deriveOk === derive.length;
  const bareByChapter = new Map<number, number>();
  for (const b of bare) bareByChapter.set(Number(b.section.split(".")[0]), (bareByChapter.get(Number(b.section.split(".")[0])) ?? 0) + 1);
  criteria.push({
    id: "P1.3",
    text: "Every derived figure resolves through GET /figures/{id}/derive; every cited figure links to a source row with a verification date; every illustrative figure carries the ill chip; a crawl of all sections reports zero bare numbers.",
    status: figuresPass ? "pass" : "fail",
    measured: `derived ${count("DERIVED") - derivedUnlinked}/${count("DERIVED")} linked · open (derived, unlinked) ${open} · cited ${count("PRIMARY") + count("VENDOR") + count("ANALYST") + count("PRACTITIONER") - citedWithoutRow} with a row, ${citedWithoutRow} without · illustrative ${illustrative} with ${illChips} chips · bare numbers ${bare.length}${up ? ` · derive endpoint ${deriveOk}/${derive.length} sampled 200` : " · derive endpoint not sampled"}`,
    note: `Figure, DeriveLink and SourceRow rows of the release (SourceRow.verifiedAt is not null by schema); the chip count is class="fig-ill" in the stored HTML; bare numbers are counted in stored paragraphs outside chips, links and figure spans with the pipeline's exclusions${bare.length > 0 ? `, by chapter: ${[...bareByChapter.entries()].sort((a, b) => a[0] - b[0]).map(([c, n]) => `ch${pad(c)} ${n}`).join(", ")}; first: ${bare.slice(0, 3).map((b) => `${b.section} "${b.token}" (${b.context})`).join(" | ")}` : ""}. ${open > 0 ? `The ${open} OPEN figures are derived numbers the matcher could not link to derive.py (Open Questions: Reader D2, the book or the matcher moves). ` : ""}Derive endpoint: the first ${DERIVE_SAMPLE} derived anchors in order.`,
  });

  /* The end-to-end suite's report (unit 23d; `npm run test:e2e`): P1.4, P1.6 and P1.9 read it. A file that is not a report reads as no report. */
  const e2eFile = join("pipeline", "reports", e2eReportName(release.id));
  let e2e: E2eReport | null = null;
  if (existsSync(e2eFile)) {
    const parsed = E2eReportSchema.safeParse(JSON.parse(readFileSync(e2eFile, "utf8")));
    e2e = parsed.success ? parsed.data : null;
  }

  /* P1.4 · cross-references resolve (rows), and every one opens a peek that gives the focus back (the e2e suite) */
  const xrefs = await prisma.crossReference.findMany({ where: inRelease, select: { targetKind: true, targetId: true }, distinct: ["targetKind", "targetId"] });
  const sectionAnchors = new Set(sections.map((s) => s.anchor));
  const chapterIds = new Set(chapters.map((c) => `ch${pad(c.chapterNumber)}`));
  const labIds = new Set((await prisma.lab.findMany({ where: inRelease, select: { anchor: true } })).map((l) => l.anchor.replace(/^lab-/, "lab")));
  const rowAnchors = new Set((await prisma.sourceRow.findMany({ where: inRelease, select: { anchor: true } })).map((r) => r.anchor));
  const unresolved = xrefs.filter((x) => !(x.targetKind === "section" ? sectionAnchors.has(x.targetId) : x.targetKind === "chapter" ? chapterIds.has(x.targetId) : x.targetKind === "lab" ? labIds.has(x.targetId) : rowAnchors.has(x.targetId)));
  criteria.push(peekCriterion(e2e, release.id, sections.length, { total: xrefs.length, unresolved: unresolved.map((x) => `${x.targetKind} ${x.targetId}`) }));

  /* P1.5 · search under 500 ms at p95, filters as WHERE clauses */
  const timings: number[] = [];
  for (const q of QUERIES) {
    for (const filters of [{ ...EMPTY_FILTERS, q }, { ...EMPTY_FILTERS, q, layer: [2 as const], part: ["P2" as const] }]) {
      const started = performance.now();
      /* Phase 1's criterion is the lexical statement: no query vector (feature-specs/12 § 5). */
      await searchRelease(release.id, filters, EMPTY_FILTERS.n, null);
      timings.push(performance.now() - started);
    }
  }
  const p95 = percentile(timings, 95);
  criteria.push({
    id: "P1.5",
    text: "Search returns results in under 500 ms at p95 with filters by part, layer, source tier, verification age and type applied as WHERE clauses; the query instrument shows the measured time.",
    status: p95 < SEARCH_P95_MS ? "pass" : "fail",
    measured: `p95 ${p95.toFixed(0)} ms · max ${Math.max(...timings).toFixed(0)} ms over ${timings.length} statements`,
    note: `searchRelease() (the one statement of lib/search/hybrid.ts, filters as WHERE clauses by construction) for ${QUERIES.length} queries, each plain and with a layer + part filter, on this database. The instrument's displayed time is the same measurement (SearchData.timings).`,
  });

  /* P1.6 · reading paths per account and resume across devices */
  criteria.push(resumeCriterion(e2e, release.id));

  /* P1.7 · chapter load p95 under k6 and the RSC payload */
  const firsts = chapters.map((c) => sections.find((s) => s.chapterVersion.chapterNumber === c.chapterNumber)).filter((s) => s !== undefined);
  const rsc = up ? await crawl(firsts.map((s) => `${app}/en/ch/${pad(s.chapterVersion.chapterNumber)}/${s.anchor}`), { RSC: "1" }) : [];
  const rscMax = rsc.length === 0 ? 0 : Math.max(...rsc.map((r) => r.bytes));
  const rscOver = rsc.filter((r) => r.bytes >= RSC_MAX_BYTES);
  criteria.push({
    id: "P1.7",
    text: "Chapter load is under 1 s at p95 for 20 pilot accounts × 10 concurrent users under k6, with an RSC payload under 150 KB per chapter.",
    status: up && rscOver.length === 0 && rsc.length === firsts.length && rsc.every((r) => r.status === 200) ? "deferred" : "fail",
    measured: up ? `RSC payload max ${kb(rscMax)} over ${rsc.length} chapters (first section, EN)${rscOver.length > 0 ? `; over 150 KB: ${rscOver.map((r) => r.url.replace(app, "")).join(", ")}` : ""} · k6 p95 not measured` : "server not reachable",
    note: `The RSC payload is the body of each chapter's first section fetched with the RSC: 1 header${rsc.some((r) => r.status !== 200) ? ` (${rsc.filter((r) => r.status !== 200).length} not 200)` : ""}. The concurrent p95 is unit 23b (k6 is not installed on this machine).`,
  });

  /* P1.8 · PT truncation snapshots: the suite's own report (unit 23c). A file that is not a report reads as no report. */
  const truncationFile = join("pipeline", "reports", truncationReportName(release.id));
  let truncation: TruncationReport | null = null;
  if (existsSync(truncationFile)) {
    const parsed = TruncationReportSchema.safeParse(JSON.parse(readFileSync(truncationFile, "utf8")));
    truncation = parsed.success ? parsed.data : null;
  }
  criteria.push(truncationCriterion(truncation, release.id));

  /* P1.9 · the reader's flows in both languages with axe, and the keyboard map on every reader page */
  criteria.push(flowsCriterion(e2e, release.id, sections.length));

  /* P1.10 · pilot accounts through SSO */
  const sso = await withSystem(() => prisma.user.count({ where: { deletedAt: null, identities: { some: {} } } }));
  criteria.push({
    id: "P1.10",
    text: "20 pilot accounts are onboarded via SSO.",
    status: sso >= PILOT_ACCOUNTS ? "pass" : "blocked",
    measured: `${sso}/${PILOT_ACCOUNTS} accounts with a Google or GitHub identity`,
    note: `User rows with at least one Identity row and no deletion (the dev provider creates none). ${sso < PILOT_ACCOUNTS ? "Onboarding needs the real Google and GitHub credentials in Keycloak's vault and the pilot allow-list (unit 23e)." : ""}`,
  });

  const { met } = gateVerdict(criteria);
  const report: GateReport = { phase: 1, release: release.id, appUrl: app, criteria, met, startedAt, finishedAt: new Date().toISOString() };
  mkdirSync(join("pipeline", "reports"), { recursive: true });
  const out = join("pipeline", "reports", `phase1-gate-${release.id}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(formatGateReport(report));
  console.log(`\nreport written to ${out}`);
  return met ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
