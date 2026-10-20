import type { Part } from "@/lib/db/generated/enums";
import { chaptersOfPart, embedReleaseStatus, retrievedSections, vectorReady, type EmbedReleaseStatus, type RetrievedSectionRow } from "@/lib/db/search";
import { AppError } from "@/lib/errors";
import { BudgetExceededError, GatewayRefusedError, GatewayUnavailableError } from "@/lib/gateway/errors";
import type { Lang, VerifyStatus } from "@/lib/schemas/domain";
import type { GatewayCall, Principal } from "@/lib/schemas/gateway";
import { ASSISTANT_MODES } from "@/lib/schemas/golden";
import { parseFigureId, parseSectionId, type FigureId, type ReleaseId, type SectionId } from "@/lib/schemas/ids";
import { EMBED_QUERY_MAX_CHARACTERS } from "@/lib/schemas/workers";
import { EMPTY_FILTERS } from "@/lib/search/filters";
import { NO_REFERENCES, referencesOf, type QuestionReferences } from "@/lib/sensors/references";
import { searchRelease, type QueryVector, type SearchScope } from "@/lib/search/hybrid";

/*
 * What the assistant is shown (feature-specs/12 § 7.2; architecture § 1, § 6.3): embed the question, run the fused
 * statement over the mode's candidate sections, re-rank the candidates against the question, and hand back the top
 * eight with the sections the mode always includes. What retrieval hands over decides what the answer can cite, so
 * the set is ordered, small, and plain text: HTML never reaches a model.
 *
 * This module holds no gateway of its own (invariant 6): the two model calls arrive as functions, which the workers
 * — the only process with a key — supply from `workers/embed.ts` `embedQuery` and `lib/gateway/rerank.ts` `rerank`.
 * A failing half never refuses the answer: without a vector the lexical half feeds the re-ranker, and without the
 * re-ranker the fused order stands with no scores (D8).
 *
 * A question whose words all fall out of `websearch_to_tsquery` has no candidates at all, because the statement's
 * vector half runs only for a query carrying a lexeme (`lib/search/hybrid.ts`, review round 2, 2026-09-24; 12 § 7.2):
 * the scope sensor of spec 13 refuses such a question before retrieval is asked.
 */

/** Candidates the statement returns before the re-rank, and how many of them survive it (§ 7.2). */
export const CANDIDATES = 40;
export const TOP_N = 8;
/** Retrieval and re-rank budget inside the 2 s first-token budget (architecture § 8); it reports, never refuses. */
export const RETRIEVE_BUDGET_MS = 600;
/** The part the executive brief reads (project-overview § Features: Executive brief from Part III). */
export const BRIEF_PART: Part = "P3";

export type RetrieveMode = (typeof ASSISTANT_MODES)[number];

export interface RetrieveContext {
  /** The chapter the mode works on: the aid's in a walk, the lab's in lab mode, null otherwise (feature-specs/23 § 5.1). */
  readonly chapter: number | null;
  readonly section: SectionId | null;
  /** Compare mode: the two chapters being compared. */
  readonly chapters?: readonly [number, number];
  /** Lab mode: the lab whose chapter is read (the README itself is spec 19's, see the module's note). */
  readonly labId?: string;
}

export interface RetrieveRequest {
  readonly releaseId: ReleaseId;
  /** The reader's own words, at most the composer's 800 characters (§ 7.2). */
  readonly question: string;
  readonly mode: RetrieveMode;
  readonly context: RetrieveContext;
  readonly principal: Principal;
  readonly traceId: string;
  /**
   * What the two calls' ledger rows name as their `ref` (feature-specs/48 § 5.3): a person's research run's id, so the
   * run's statistics and the spend's view count retrieval's share of it. The Assistant's turn gives none, as before.
   */
  readonly ref?: string;
}

export interface RetrievedSection {
  readonly sectionId: SectionId;
  readonly chapter: number;
  readonly layer: number;
  readonly title: string;
  readonly version: string;
  readonly verify: VerifyStatus;
  /** The language of `text`: EN while only the EN edition is plain text and embedded (§ 10). */
  readonly editionLang: Lang;
  /** Plain text the model reads; html is never sent to a model. */
  readonly text: string;
  /** For the citation sensor (spec 13). */
  readonly figureIds: ReadonlyArray<FigureId>;
  /**
   * A lab pseudo-section (feature-specs/19 § 4): the README or the last run, read by the model under its own id and
   * cited as `sectionId`, the chapter's lab section, which the sensors read merged with it.
   */
  readonly pseudo?: { readonly id: string; readonly labId: string; readonly kind: "readme" | "lastRun" };
  readonly rank: {
    readonly lexicalPos: number | null;
    readonly vectorPos: number | null;
    /** The cross-encoder's score, null when the re-ranker did not run (D8) or the section was appended (§ 7). */
    readonly rerankScore: number | null;
    /** The section's place in the set handed over, from 1. */
    readonly final: number;
  };
  readonly truncated: boolean;
}

export interface Retrieved {
  /** The re-ranked eight, then the sections the mode always includes that they did not already hold (§ 7). */
  readonly sections: ReadonlyArray<RetrievedSection>;
  /** Fused set size before the re-rank (≤ CANDIDATES). */
  readonly candidates: number;
  readonly timings: { readonly embedMs: number; readonly sqlMs: number; readonly rerankMs: number; readonly totalMs: number };
  readonly overBudget: boolean;
  /**
   * The vector half ran: false when the release is not vector-ready (§ 4.2) and false when the embedding call was
   * refused, since in both cases the lexical half alone fed the re-ranker and the answer's span should say so.
   */
  readonly vectorReady: boolean;
}

/** The call the two gateway functions are given: the alias and the purpose are theirs, not retrieval's. */
export type RetrieveGatewayCall = Omit<GatewayCall, "alias" | "purpose">;

export type EmbedQueryFn = (call: RetrieveGatewayCall, text: string) => Promise<{ readonly embedding: ReadonlyArray<number>; readonly ms: number }>;

export type RerankFn = (
  call: RetrieveGatewayCall,
  input: { readonly query: string; readonly documents: ReadonlyArray<{ readonly id: string; readonly text: string }>; readonly topN: number },
) => Promise<{ readonly hits: ReadonlyArray<{ readonly id: string; readonly score: number; readonly truncated: boolean }>; readonly ms: number }>;

export interface RetrieveDeps {
  readonly embed: EmbedQueryFn;
  readonly rerank: RerankFn;
  readonly search?: typeof searchRelease;
  readonly sections?: typeof retrievedSections;
  readonly status?: (releaseId: string) => Promise<EmbedReleaseStatus>;
  readonly partChapters?: (releaseId: string, part: Part) => Promise<ReadonlyArray<number>>;
}

/** The candidate set and the always-included sections of a mode (§ 7.2's table). */
export interface ModePlan {
  readonly scope: SearchScope;
  /** Section anchors the mode always hands over, in the order they are appended. */
  readonly always: ReadonlyArray<string>;
  /** How many of `always` are handed over, counting only those the release has: absent means all of them. */
  readonly limit?: number;
}

/** The most sections a question's own references add to the set: what compare's two `.1` sections add (feature-specs/23 D7). */
export const REFERENCED_MAX = 2;
/** A chapter's layers, 1 to 9: the most sections a chapter has (`SectionIdSchema`). */
const LAYERS = 9;

function pad(chapter: number): string {
  return String(chapter).padStart(2, "0");
}

/**
 * The mode's scope and its always-included sections (§ 7.2). Unverified chapters are excluded from every candidate
 * set: the scope sensor refuses a question about an unverified chapter before retrieval, and a verified chapter's
 * answer must not cite an unverified one either (architecture § 6.1). `briefChapters` is the release's own Part III,
 * read from the database rather than written here, so a chapter that changes part does not need this function.
 */
export function planOf(mode: RetrieveMode, context: RetrieveContext, briefChapters: ReadonlyArray<number>, references: QuestionReferences = NO_REFERENCES): ModePlan {
  const verifiedOnly = true;
  if (mode === "explain") {
    /* What the question names decides what it is asked of (feature-specs/23 § 5.3). Three cases, in this order:

       It names sections ("section 21.3", or a bare "21.3"). D7 in its Assistant 2.0 form: "ask about 21.3" must be
       able to cite 21.3, and the section is in the set because the question names it, not because the reader is
       on it. The whole release is searched and the first two named sections are added; a chapter the same
       question mentions adds its opening section after them, within the same two.

       It names one chapter and no section. The chapter is read whole: its sections are the candidate set and all
       nine are handed over, the eight the re-rank kept and the one it did not. That is the size of Assistant 1's
       set, eight and the section the reader was on.

       It names several chapters and no section. They are the candidate set, as a compare's pair is, with each
       one's opening section added, two at most.

       The narrowing is measured, not assumed (unit 40e, 2026-10-04, the stub run): the golden set's 50 "which
       source does chapter NN give for …" questions are answered by the chapter's own `.9`, which Assistant 1 had
       because the reader stood on it. Searching the whole release found it for 8 of them; the chapter's own
       sections, top eight, for 46; the chapter whole, for all 50. */
    const sections = [...new Set([...references.namedSections, ...references.bareSections])];
    const chapters = [...references.namedChapters];
    const openings = chapters.map((chapter) => `${pad(chapter)}.1`);
    if (sections.length > 0) return { scope: { chapters: [], verifiedOnly }, always: [...new Set([...sections, ...openings])], limit: REFERENCED_MAX };
    const [only] = chapters;
    if (only !== undefined && chapters.length === 1) {
      return { scope: { chapters, verifiedOnly }, always: Array.from({ length: LAYERS }, (_, index) => `${pad(only)}.${String(index + 1)}`), limit: LAYERS };
    }
    return { scope: { chapters, verifiedOnly }, always: openings, limit: REFERENCED_MAX };
  }
  if (mode === "compare") {
    const pair = context.chapters;
    if (pair === undefined) throw new AppError("RETRIEVE_CONTEXT", "compare mode needs the two chapters being compared (feature-specs/12 § 7.2)");
    return { scope: { chapters: [...pair], verifiedOnly }, always: pair.map((chapter) => `${pad(chapter)}.1`) };
  }
  if (mode === "walk") {
    /* The aid's chapter and its own section; the derive results the caller adds are spec 18's. */
    if (context.chapter === null) throw new AppError("RETRIEVE_CONTEXT", "walk mode needs the aid's chapter (feature-specs/23 § 5.1)");
    return { scope: { chapters: [context.chapter], verifiedOnly }, always: [context.section ?? `${pad(context.chapter)}.8`] };
  }
  if (mode === "lab") {
    if (context.chapter === null) throw new AppError("RETRIEVE_CONTEXT", "lab mode needs the lab's chapter (feature-specs/23 § 5.1)");
    return { scope: { chapters: [context.chapter], verifiedOnly }, always: [`${pad(context.chapter)}.4`] };
  }
  if (briefChapters.length === 0) {
    throw new AppError("RETRIEVE_BRIEF_EMPTY", `the release has no ${BRIEF_PART} chapter to brief from (feature-specs/12 § 7.2)`);
  }
  /* Part III and nothing added: a brief has no position to add a decision aid from (feature-specs/23 § 5.3). */
  return { scope: { chapters: [...briefChapters], verifiedOnly }, always: [] };
}

function sectionOf(row: RetrievedSectionRow, rank: RetrievedSection["rank"], truncated: boolean): RetrievedSection {
  return {
    sectionId: parseSectionId(row.anchor),
    chapter: row.chapter,
    layer: row.layer,
    title: row.title,
    version: row.version,
    verify: row.verify,
    editionLang: "EN",
    text: row.text,
    figureIds: row.figureIds.map(parseFigureId),
    rank,
    truncated,
  };
}

/**
 * A gateway half the gateway itself refused leaves retrieval to the other one (§ 7.2, D8): the three typed refusals
 * of spec 11 § 5.2 — a spent budget, an unreachable gateway, and a refused request (a 400 that is not a budget
 * message, 401, 403, 404, 413: an unpermitted alias, a payload the provider will not take), which `lib/gateway/
 * rerank.ts` names as one of the things retrieval reads to keep the fused order instead. An untyped failure is a
 * defect in retrieval's own call (`GATEWAY_EMBED_DIMENSIONS`, `GATEWAY_RERANK_EMPTY`) and still raises.
 */
function isHalfRefused(error: unknown): boolean {
  return error instanceof BudgetExceededError || error instanceof GatewayUnavailableError || error instanceof GatewayRefusedError;
}

/**
 * The sections the assistant is shown, in the order it should read them. The question is embedded only when the
 * release is vector-ready (§ 4.2); the statement runs over the mode's scope with `kind = 'section'` and
 * `limit 40`; the re-ranker scores those candidates and the top eight stand, followed by the mode's always-included
 * sections that the eight did not already hold. `overBudget` is recorded, never enforced.
 */
export async function retrieve(request: RetrieveRequest, deps: RetrieveDeps): Promise<Retrieved> {
  const question = request.question.trim();
  if (question.length === 0 || question.length > EMBED_QUERY_MAX_CHARACTERS) {
    throw new AppError("RETRIEVE_QUESTION", `a question is 1 to ${EMBED_QUERY_MAX_CHARACTERS} characters, not ${question.length} (feature-specs/12 § 7.2)`);
  }
  const search = deps.search ?? searchRelease;
  const sections = deps.sections ?? retrievedSections;
  const status = deps.status ?? embedReleaseStatus;
  const partChapters = deps.partChapters ?? chaptersOfPart;
  const started = performance.now();
  /* The ledger row of each call carries the caller's ref: a research run's id (48 § 5.3), or none for an Assistant
     turn, whose message id is spec 15's — retrieval has no id of its own. */
  const call: RetrieveGatewayCall = { guide: null, principal: request.principal, traceId: request.traceId, ref: request.ref ?? null };

  const plan = planOf(request.mode, request.context, request.mode === "brief" ? await partChapters(request.releaseId, BRIEF_PART) : [], referencesOf(request.question));

  let vector: QueryVector | null = null;
  let embedMs = 0;
  const ready = vectorReady(await status(request.releaseId));
  if (ready) {
    try {
      const embedded = await deps.embed(call, question);
      vector = { embedding: embedded.embedding, ms: embedded.ms };
      embedMs = embedded.ms;
    } catch (error: unknown) {
      if (!isHalfRefused(error)) throw error;
    }
  }

  const raw = await search(request.releaseId, { ...EMPTY_FILTERS, q: question, type: ["section"], n: CANDIDATES }, CANDIDATES, vector, plan.scope);
  const sqlMs = Math.round(raw.lexicalMs);
  const candidates = raw.hits;
  const rows = new Map((await sections(request.releaseId, [...candidates.map((hit) => hit.id), ...plan.always], plan.scope)).map((row) => [row.anchor, row]));

  let rerankMs = 0;
  let scores: ReadonlyMap<string, { readonly score: number; readonly truncated: boolean }> | null = null;
  const documents = candidates.flatMap((hit) => {
    const row = rows.get(hit.id);
    return row === undefined ? [] : [{ id: hit.id, text: row.text }];
  });
  if (documents.length > 0) {
    try {
      const reranked = await deps.rerank(call, { query: question, documents, topN: TOP_N });
      rerankMs = reranked.ms;
      scores = new Map(reranked.hits.map((hit) => [hit.id, { score: hit.score, truncated: hit.truncated }]));
    } catch (error: unknown) {
      if (!isHalfRefused(error)) throw error;
    }
  }

  /* The re-ranked eight, or — when the re-ranker did not answer (D8) — the first eight of the fused order, then
     the mode's always-included sections in the table's order. Without duplicates means of the eight and of each
     other: compare mode given the same chapter twice names one `NN.1` twice (architecture § 12, unit 26c). */
  const kept = scores === null ? documents.slice(0, TOP_N).map((document) => document.id) : [...scores.keys()];
  /* A plan with a limit hands over the first of its sections that the release has, verified: a question may name a
     section that does not exist, and it must not use up the place of one that does. */
  const always = plan.limit === undefined ? plan.always : plan.always.filter((anchor) => rows.has(anchor)).slice(0, plan.limit);
  const order = [...new Set([...kept, ...always])];
  const out: RetrievedSection[] = [];
  for (const anchor of order) {
    const row = rows.get(anchor);
    if (row === undefined) continue;
    const hit = candidates.find((candidate) => candidate.id === anchor);
    const score = scores?.get(anchor) ?? null;
    out.push(
      sectionOf(
        row,
        { lexicalPos: hit?.lexical_pos ?? null, vectorPos: hit?.vector_pos ?? null, rerankScore: score === null ? null : score.score, final: out.length + 1 },
        score?.truncated ?? false,
      ),
    );
  }

  const totalMs = Math.round(performance.now() - started);
  return {
    sections: out,
    candidates: documents.length,
    timings: { embedMs, sqlMs, rerankMs, totalMs },
    overBudget: totalMs > RETRIEVE_BUDGET_MS,
    vectorReady: vector !== null,
  };
}
