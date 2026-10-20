import { newTraceId } from "@/lib/api/trace";
import type { SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { ageDays, cached, currentRelease, pad, requireDatabase } from "@/lib/db/shared";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { EMBED_TARGET } from "@/lib/gateway/prices";
import type { Locale } from "@/lib/i18n/routing";
import { withDraft } from "@/lib/assistant/links";
import { searchHref, type SearchFilters } from "@/lib/search/filters";
import type { Part } from "@/lib/db/generated/enums";
import type { SourceTier, VerifyStatus } from "@/lib/schemas/domain";
import { principalOfId, type Principal } from "@/lib/schemas/gateway";
import { lexemesOf, markupSnippet, matchedTerms, searchRelease, type QueryVector, type RawHit, type SearchScope } from "@/lib/search/hybrid";
import { SearchDataSchema, type SearchData, type SearchDataInput, type VectorState } from "@/lib/schemas/search";
import { currentTraceId } from "@/lib/telemetry/spans";
import { defaultWorkersDeps, workersFetch, WorkersRefusedError, WorkersUnavailableError, type WorkersClientDeps } from "@/lib/workers/client";

/*
 * The search page's loader (feature-specs/06 § 5.3): the statement once, the
 * index summary from the release cache, the actions from the first hits.
 *
 * The vector half of the rank needs the query embedded, which only the workers
 * can do (invariant 6), so the loader asks them first and runs the lexical
 * statement alone when they do not answer within the route's 150 ms: search is a
 * read of the book and never fails because a model service is down (12 § 6, D6).
 */

const TARGET_MS = 500;
export { TARGET_MS as SEARCH_TARGET_MS };

const loadIndexSummary = cached("search-index", async () => {
  const prisma = getPrisma();
  const release = await currentRelease();
  const where = { chapterVersion: { releaseId: release.id } };
  const [chapters, sections, labs, rows, ptParity] = await Promise.all([
    prisma.chapterVersion.count({ where: { releaseId: release.id } }),
    prisma.section.count({ where }),
    prisma.lab.count({ where }),
    prisma.sourceRow.count({ where }),
    prisma.edition.count({ where: { chapterVersion: { releaseId: release.id }, lang: "PT", status: "PARITY" } }),
  ]);
  return { id: release.id, gitSha: release.gitSha, chapters, sections, labs, rows, builtAt: release.ingestedAt.toISOString(), hash: release.renderHash, editions: ptParity > 0 ? ("EN_PT" as const) : ("EN" as const) };
});

function hitView(raw: RawHit, locale: Locale, now: Date): SearchDataInput["hits"][number] {
  const chapter = pad(raw.chapter);
  const verifiedAt = raw.verifiedAt === null ? null : new Date(raw.verifiedAt);
  const base = {
    chapter: raw.chapter,
    chapterTitle: raw.ctitle.length > 0 ? raw.ctitle : `Chapter ${chapter}`,
    snippet: markupSnippet(raw.snippet),
    layer: raw.layer,
    /* the statement emits tier names; the schema checks them on the way out */
    tiers: raw.tiers as ReadonlyArray<SourceTier | "SCENARIO">,
    verifiedDays: verifiedAt === null || raw.verify !== "PASSED" ? null : ageDays(verifiedAt, now),
    stale: raw.stale_row === null || raw.stale_days === null ? null : { rowId: raw.stale_row, days: raw.stale_days },
    derive: raw.derive_line === null || raw.derive_lab === null ? null : { line: raw.derive_line, labId: raw.derive_lab },
    /* the fused rank of the statement (12 § 5), the number `sort = relevance` ordered by */
    rank: raw.rank,
  };
  if (raw.kind === "lab") {
    return {
      ...base,
      kind: "lab",
      id: raw.id,
      label: `Lab ${chapter}`,
      title: raw.title.length > 0 ? raw.title : base.chapterTitle,
      rowOrdinal: null,
      href: `/${locale}/labs/${raw.id}`,
      version: null,
      lab: { verdict: raw.lab_verdict === null ? "NOT_REPRODUCED" : (raw.lab_verdict as "REPRODUCED" | "NOT_REPRODUCED" | "KILLED" | "ERROR"), checkedAt: raw.lab_checked },
    };
  }
  if (raw.kind === "row") {
    const title = raw.title.length > 80 ? `${raw.title.slice(0, 80).replace(/\s+\S*$/, "")}…` : raw.title;
    return {
      ...base,
      kind: "row",
      id: raw.id,
      label: raw.id,
      title: title.length > 0 ? title : raw.id,
      rowOrdinal: raw.row_ordinal,
      href: `/${locale}/ch/${chapter}/${chapter}.9#r${raw.row_ordinal ?? ""}`,
      version: raw.version,
      lab: null,
    };
  }
  return {
    ...base,
    kind: "section",
    id: raw.id,
    label: raw.id,
    title: raw.title,
    rowOrdinal: null,
    href: `/${locale}/ch/${chapter}/${raw.id}`,
    version: raw.version,
    lab: null,
  };
}

/**
 * The principal a signed-out reader's query embedding is charged to (`GATEWAY_ANONYMOUS_PRINCIPAL`, 12 § 6): an
 * organisation or a user the operator names, never a value this code invents, so the vector half runs for everyone
 * without an anonymous form entering `Principal` (Andre's answer of 2026-09-24; architecture § 12). Null while the
 * variable is unset, which leaves an anonymous search lexical as before.
 */
export function anonymousPrincipal(value: string | undefined = env.GATEWAY_ANONYMOUS_PRINCIPAL): Principal | null {
  return value === undefined ? null : principalOfId(value);
}

/**
 * Whose key and whose budget the query embedding is charged to: the reader's organisation, or the reader on an
 * individual account (spec 11 § 3.4); for a reader with no session, the configured anonymous principal, whose
 * budget an anonymous visitor therefore spends (12 § 6).
 */
export function principalOf(user: SessionUser | null, anonymous: Principal | null = anonymousPrincipal()): Principal | null {
  if (user === null) return anonymous;
  return user.organisationId === null ? { userId: user.id } : { organisationId: user.organisationId };
}

/** Either the principal whose call to make, or the state to report without making one. */
export type VectorPlan = { readonly embed: Principal } | { readonly state: VectorState };

/**
 * What the vector half can do before anything is spent (12 § 6): a release still missing a vector at the pin is
 * `indexing`; a page without a query needs no vector and reports the index's readiness; a reader with no principal
 * — signed out with `GATEWAY_ANONYMOUS_PRINCIPAL` unset — has no budget the call could be charged to, so their
 * search stays lexical.
 */
export function vectorPlan(status: EmbedReleaseStatus, text: string, principal: Principal | null): VectorPlan {
  if (!vectorReady(status)) return { state: "indexing" };
  if (text.length === 0) return { state: "ok" };
  return principal === null ? { state: "unavailable" } : { embed: principal };
}

/**
 * The query's vector, or the reason the page has none. Anything the workers or the gateway refuse — a timeout at
 * the route's 150 ms, a stopped workers process, a spent budget — is `unavailable` and never an error the reader
 * sees (D6).
 */
async function queryVector(releaseId: string, text: string, principal: Principal | null, workers: WorkersClientDeps): Promise<{ readonly vector: QueryVector | null; readonly state: VectorState }> {
  const plan = vectorPlan(await embedReleaseStatus(releaseId), text, principal);
  if (!("embed" in plan)) return { vector: null, state: plan.state };
  const started = performance.now();
  try {
    /* The request's own trace when the search runs inside one (the API route), so the workers' spans join it; a page's loader has none and starts one. */
    const answer = await workersFetch("/embed/query", { text, principal: plan.embed }, { traceId: currentTraceId() ?? newTraceId() }, workers);
    return { vector: { embedding: answer.embedding, ms: performance.now() - started }, state: "ok" };
  } catch (error: unknown) {
    if (error instanceof WorkersUnavailableError || error instanceof WorkersRefusedError) return { vector: null, state: "unavailable" };
    throw error;
  }
}

/** Everything the search page renders (feature-specs/06 § 4). */
export async function getSearchData(locale: Locale, filters: SearchFilters, user: SessionUser | null, parseMs: number, workers: WorkersClientDeps = defaultWorkersDeps(), anonymous: Principal | null = anonymousPrincipal()): Promise<SearchData> {
  requireDatabase();
  const started = performance.now();
  const now = new Date();
  const index = await loadIndexSummary();
  const hasQuery = filters.q.length > 0;
  const vector = await queryVector(index.id, filters.q, principalOf(user, anonymous), workers);
  const raw = await searchRelease(index.id, filters, hasQuery ? filters.n : 0, vector.vector);
  const assembleStart = performance.now();
  const hits = raw.hits.map((h) => hitView(h, locale, now));
  const queryLexemes = lexemesOf(raw.tsq);
  const firstLab = hasQuery ? raw.firstLab : null;
  const assembleMs = performance.now() - assembleStart;
  const totalMs = parseMs + (performance.now() - started);
  return SearchDataSchema.parse({
    release: { id: index.id, gitSha: index.gitSha },
    filters,
    hits,
    count: hasQuery ? raw.total : 0,
    facets: raw.facets,
    terms: { query: queryLexemes, matched: matchedTerms(raw.hits.map((h) => h.snippet), filters.q) },
    stopWordsOnly: hasQuery && queryLexemes.length === 0,
    timings: { parseMs, lexicalMs: raw.lexicalMs, vectorMs: raw.vectorMs, assembleMs, totalMs },
    vector: vector.state,
    index: { chapters: index.chapters, sections: index.sections, labs: index.labs, rows: index.rows, builtAt: index.builtAt, hash: index.hash, editions: index.editions },
    actions: {
      /* `Ask about <query>`: the dock over these results, holding the query (feature-specs/24 § 6.2). The assistant is
         asked about the book, not about the first hit's chapter, so the link stays on this page. */
      askHref: hasQuery ? withDraft(searchHref(locale, filters), filters.q) : null,
      lab: firstLab === null ? null : { id: firstLab.id, href: `/${locale}/labs/${firstLab.id}`, minutes: firstLab.runtime === null ? null : Math.max(1, Math.round(firstLab.runtime / 60)) },
    },
    signedIn: user !== null,
    sourceLang: "EN",
  });
}
/*
 * The embedding job's queries (feature-specs/12 § 4.2). They read and write content rows, which the client extension
 * reserves for the pipeline: the two reads are raw statements over the release (the `vector` column is `Unsupported`,
 * so Prisma can neither select nor set it) and the two writes — a batch's vectors, and since unit 54c the vectors an
 * unchanged section carries from an earlier release — refuse unless the job set `EMBED=1`, because a raw statement does
 * not pass the extension's guard. All four are listed in lib/db/RAW_SQL.md.
 */

export interface EmbedReleaseStatus {
  readonly sections: number;
  /** Sections holding a vector from the current pin; a release is vector-ready when this equals `sections`. */
  readonly embedded: number;
  readonly model: string;
}

/**
 * A release is vector-ready when every one of its sections holds a vector at the current pin (§ 4.2): the search
 * page's `indexing` state and retrieval's `vectorReady` are the same reading.
 */
export function vectorReady(status: EmbedReleaseStatus): boolean {
  return status.sections > 0 && status.embedded === status.sections;
}

/** The release's embedding coverage at the pin: the search instrument (26b) and the Phase 2 gate read it. */
export async function embedReleaseStatus(releaseId: string): Promise<EmbedReleaseStatus> {
  requireDatabase();
  const rows = await getPrisma().$queryRaw<ReadonlyArray<{ sections: number; embedded: number }>>`
    SELECT count(*)::int AS sections,
           (count(*) FILTER (WHERE s.embedding IS NOT NULL AND s."embeddingModel" = ${EMBED_TARGET}))::int AS embedded
    FROM "Section" s
    JOIN "ChapterVersion" cv ON cv.id = s."chapterVersionId"
    WHERE cv."releaseId" = ${releaseId}`;
  const row = rows[0];
  return { sections: row?.sections ?? 0, embedded: row?.embedded ?? 0, model: EMBED_TARGET };
}

export interface SectionToEmbed {
  readonly sectionId: string;
  readonly anchor: string;
  readonly chapter: number;
  /** What the model reads: `textEn` (the chapter title and the layer's prose, 06 D1), a layer-9 section its rows. */
  readonly text: string;
}

/**
 * Every section of the release whose vector is missing or was made by another pin, in chapter order. A layer-9
 * section (Sources) embeds its rows' claims and citations too, since its own prose is the table's introduction
 * alone (§ 4.2).
 */
export async function sectionsToEmbed(releaseId: string): Promise<ReadonlyArray<SectionToEmbed>> {
  requireDatabase();
  return getPrisma().$queryRaw<ReadonlyArray<SectionToEmbed>>`
    SELECT s.id AS "sectionId", s.anchor, cv."chapterNumber" AS chapter,
           s."textEn" || CASE WHEN s.ordinal = 9 THEN COALESCE(
             (SELECT ' ' || string_agg(r.claim || ' — ' || r.citation, ' ' ORDER BY r.ordinal)
                FROM "SourceRow" r WHERE r."chapterVersionId" = s."chapterVersionId"), '') ELSE '' END AS text
    FROM "Section" s
    JOIN "ChapterVersion" cv ON cv.id = s."chapterVersionId"
    WHERE cv."releaseId" = ${releaseId}
      AND (s.embedding IS NULL OR s."embeddingModel" IS DISTINCT FROM ${EMBED_TARGET})
    ORDER BY cv."chapterNumber", s.ordinal`;
}

/**
 * The flag the one content write needs (D3). The job asks before its first gateway call, so a run started without
 * `npm run embed:release` (which sets it, as `npm run ingest` sets `PIPELINE=1`) costs nothing.
 */
export function requireEmbedWrites(): void {
  if (env.EMBED !== "1") {
    throw new AppError("CONTENT_READ_ONLY", "Section.embedding is written only by the embedding job under EMBED=1: run `npm run embed:release` (architecture § 11.3; feature-specs/12 § 4.2, D3).");
  }
}

/**
 * One batch's vectors, their pin and their date in one statement per batch (§ 4.2, D3). The vectors travel as text
 * and are cast to `vector` in the statement, which is what the column needs and what Prisma cannot express.
 */
export async function writeSectionEmbeddings(rows: ReadonlyArray<{ readonly sectionId: string; readonly embedding: ReadonlyArray<number> }>, now: Date): Promise<number> {
  requireDatabase();
  requireEmbedWrites();
  if (rows.length === 0) return 0;
  const ids = rows.map((row) => row.sectionId);
  const vectors = rows.map((row) => `[${row.embedding.join(",")}]`);
  return getPrisma().$executeRaw`
    UPDATE "Section" AS s
    SET embedding = v.embedding::vector, "embeddingModel" = ${EMBED_TARGET}, "embeddedAt" = ${now}
    FROM unnest(${ids}::text[], ${vectors}::text[]) AS v(id, embedding)
    WHERE s.id = v.id`;
}

/**
 * The vectors a new release's sections keep from an earlier one (unit 54c; Andre's answer of 2026-10-09): a section
 * whose embedded text — its `textEn`, a layer-9 section with its rows, as `sectionsToEmbed` reads it — is the text of
 * the section of the same anchor in `fromReleaseId`, whose vector is at the pin, takes that vector with its pin and its
 * date. No model is asked: a merge makes a release whose every unchanged section is ready at once, and the changed
 * ones wait for the job's own run (`npm run embed:release`), read lexically until then (`indexing`, § 4.2).
 */
export async function carryEmbeddings(releaseId: string, fromReleaseId: string): Promise<number> {
  requireDatabase();
  requireEmbedWrites();
  return getPrisma().$executeRaw`
    WITH texts AS (
      SELECT s.id, s.anchor, cv."releaseId" AS release,
             (s.embedding IS NOT NULL AND s."embeddingModel" = ${EMBED_TARGET}) AS ready,
             s."textEn" || CASE WHEN s.ordinal = 9 THEN COALESCE(
               (SELECT ' ' || string_agg(r.claim || ' — ' || r.citation, ' ' ORDER BY r.ordinal)
                  FROM "SourceRow" r WHERE r."chapterVersionId" = s."chapterVersionId"), '') ELSE '' END AS text
      FROM "Section" s
      JOIN "ChapterVersion" cv ON cv.id = s."chapterVersionId"
      WHERE cv."releaseId" IN (${releaseId}, ${fromReleaseId})
    ),
    pairs AS (
      SELECT DISTINCT ON (n.id) n.id AS target, p.id AS source
      FROM texts n
      JOIN texts p ON p.release = ${fromReleaseId} AND p.ready AND p.anchor = n.anchor AND p.text = n.text
      WHERE n.release = ${releaseId} AND NOT n.ready
      ORDER BY n.id, p.id
    )
    UPDATE "Section" AS s
    SET embedding = src.embedding, "embeddingModel" = src."embeddingModel", "embeddedAt" = src."embeddedAt"
    FROM pairs JOIN "Section" src ON src.id = pairs.source
    WHERE s.id = pairs.target`;
}

/**
 * The sections retrieval hands to the re-ranker and the assistant (feature-specs/12 § 7.2): the plain text a model
 * reads (`textEn`; HTML never reaches a model), the figure anchors the citation sensor of spec 13 checks, and the
 * chapter's version and VERIFY. The scope is applied here too, so an always-included section outside the mode's
 * candidate set — a `NN.8` of a chapter that is not in Part III, an unverified chapter's own section — is simply
 * not returned, and no caller has to repeat the rule.
 */
export interface RetrievedSectionRow {
  readonly anchor: string;
  readonly chapter: number;
  /** The layer's ordinal, 1..9. */
  readonly layer: number;
  readonly title: string;
  readonly version: string;
  readonly verify: VerifyStatus;
  readonly text: string;
  readonly figureIds: ReadonlyArray<string>;
}

export async function retrievedSections(releaseId: string, anchors: ReadonlyArray<string>, scope: SearchScope): Promise<ReadonlyArray<RetrievedSectionRow>> {
  requireDatabase();
  if (anchors.length === 0) return [];
  const rows = await getPrisma().section.findMany({
    where: {
      anchor: { in: [...anchors] },
      chapterVersion: {
        releaseId,
        ...(scope.chapters.length === 0 ? {} : { chapterNumber: { in: [...scope.chapters] } }),
        ...(scope.verifiedOnly ? { verifyStatus: "PASSED" as const } : {}),
      },
    },
    select: {
      anchor: true,
      ordinal: true,
      titleEn: true,
      textEn: true,
      chapterVersion: { select: { chapterNumber: true, version: true, verifyStatus: true } },
      figures: { select: { anchor: true }, orderBy: { ordinal: "asc" } },
    },
  });
  return rows.map((row) => ({
    anchor: row.anchor,
    chapter: row.chapterVersion.chapterNumber,
    layer: row.ordinal,
    title: row.titleEn,
    version: row.chapterVersion.version,
    verify: row.chapterVersion.verifyStatus,
    text: row.textEn,
    figureIds: row.figures.map((figure) => figure.anchor),
  }));
}

/**
 * The chapters of one part in the release, in book order: the brief's candidate set is Part III and the release's
 * own `Chapter.part` says which chapters those are, so no list of chapter numbers is written into the code
 * (feature-specs/12 § 7.2).
 */
export async function chaptersOfPart(releaseId: string, part: Part): Promise<ReadonlyArray<number>> {
  requireDatabase();
  const rows = await getPrisma().chapterVersion.findMany({
    where: { releaseId, chapter: { part } },
    select: { chapterNumber: true },
    orderBy: { chapterNumber: "asc" },
  });
  return rows.map((row) => row.chapterNumber);
}
