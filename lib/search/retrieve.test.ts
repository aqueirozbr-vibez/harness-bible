import { describe, expect, it } from "vitest";

import type { EmbedReleaseStatus, RetrievedSectionRow } from "@/lib/db/search";
import { AppError } from "@/lib/errors";
import { BudgetExceededError, GatewayRefusedError, GatewayUnavailableError } from "@/lib/gateway/errors";
import { EMBED_TARGET } from "@/lib/gateway/prices";
import { parseReleaseId, parseSectionId } from "@/lib/schemas/ids";
import type { SearchFilters } from "@/lib/search/filters";
import type { QueryVector, RawHit, RawSearchResult, SearchScope } from "@/lib/search/hybrid";
import { CANDIDATES, planOf, REFERENCED_MAX, retrieve, TOP_N, type RetrieveDeps, type RetrieveRequest } from "@/lib/search/retrieve";
import { referencesOf } from "@/lib/sensors/references";

/*
 * Retrieval's own rules (feature-specs/12 § 7.2, § 12.3): the mode's candidate scope and always-included sections,
 * the re-ranked eight, and what happens when a half does not answer. The statement, the loader and the two gateway
 * calls are doubles here; the fused rank itself is tested against the database (12 § 5 is the statement).
 */

const RELEASE = parseReleaseId("2026.09");
const EMBEDDING = Array.from({ length: 4 }, (_, i) => i / 10);

function hit(anchor: string, lexicalPos: number | null, vectorPos: number | null): RawHit {
  const chapter = Number(anchor.slice(0, 2));
  return {
    kind: "section",
    pk: `pk-${anchor}`,
    id: anchor,
    layer: Number(anchor.slice(3)),
    title: `Section ${anchor}`,
    part: "P2",
    chapter,
    ctitle: `Chapter ${chapter}`,
    version: "v1.0.0",
    verifiedAt: null,
    verify: "PASSED",
    lexical: 0.5,
    lab_verdict: null,
    lab_checked: null,
    lab_runtime: null,
    row_ordinal: null,
    rank: 0.03,
    lexical_pos: lexicalPos,
    vector_pos: vectorPos,
    tiers: [],
    stale_row: null,
    stale_days: null,
    derive_line: null,
    derive_lab: null,
    snippet: "…",
  };
}

function row(anchor: string): RetrievedSectionRow {
  const chapter = Number(anchor.slice(0, 2));
  return {
    anchor,
    chapter,
    layer: Number(anchor.slice(3)),
    title: `Section ${anchor}`,
    version: "v1.0.0",
    verify: "PASSED",
    text: `the prose of ${anchor}`,
    figureIds: [`F-${anchor.slice(0, 2)}-01`],
  };
}

function result(hits: ReadonlyArray<RawHit>, vector: QueryVector | null): RawSearchResult {
  return {
    total: hits.length,
    facets: { part: [], layer: [], tier: [], age: [], type: [], labsWithoutLayer: 0 },
    tsq: "'retry'",
    hits: [...hits],
    firstSection: null,
    firstLab: null,
    lexicalMs: 11,
    vectorMs: vector === null ? null : vector.ms,
  };
}

const READY: EmbedReleaseStatus = { sections: 362, embedded: 362, model: EMBED_TARGET };
const INDEXING: EmbedReleaseStatus = { sections: 362, embedded: 100, model: EMBED_TARGET };

interface Seen {
  readonly embeds: string[];
  readonly reranks: { readonly query: string; readonly ids: ReadonlyArray<string>; readonly topN: number }[];
  readonly searches: { readonly filters: SearchFilters; readonly limit: number; readonly vector: QueryVector | null; readonly scope: SearchScope | undefined }[];
  readonly asked: string[][];
}

function request(overrides: Partial<RetrieveRequest> = {}): RetrieveRequest {
  return {
    releaseId: RELEASE,
    /* The question names its section: since Assistant 2.0 that, and not where the reader is, puts 21.3 in the set (feature-specs/23 § 5.3). */
    question: "in section 21.3, how does an idempotency key make a retry safe",
    mode: "explain",
    context: { chapter: null, section: null },
    principal: { organisationId: "org-1" },
    traceId: "e".repeat(32),
    ...overrides,
  };
}

/** The statement, the loader and the two calls as doubles: `anchors` is what the statement found, in fused order. */
function deps(
  anchors: ReadonlyArray<string>,
  seen: Seen,
  overrides: Partial<RetrieveDeps> = {},
  options: { readonly status?: EmbedReleaseStatus; readonly rerankOrder?: ReadonlyArray<string> } = {},
): RetrieveDeps {
  return {
    embed: async (_call, text) => {
      seen.embeds.push(text);
      return { embedding: EMBEDDING, ms: 31 };
    },
    rerank: async (_call, input) => {
      seen.reranks.push({ query: input.query, ids: input.documents.map((document) => document.id), topN: input.topN });
      const order = options.rerankOrder ?? input.documents.map((document) => document.id);
      return { hits: order.slice(0, input.topN).map((id, index) => ({ id, score: 1 - index / 100, truncated: false })), ms: 42 };
    },
    search: async (_releaseId, filters, limit, vector, scope) => {
      seen.searches.push({ filters, limit, vector, scope });
      /* No vector, no vector position: the double answers the argument it was given, as the statement does. */
      return result(
        anchors.map((anchor, index) => hit(anchor, index + 1, vector === null || index >= 3 ? null : index + 1)),
        vector,
      );
    },
    sections: async (_releaseId, asked) => {
      seen.asked.push([...asked]);
      return [...asked].map((anchor) => row(anchor));
    },
    status: async () => options.status ?? READY,
    partChapters: async () => [34, 35, 36, 37, 38, 39, 40],
    ...overrides,
  };
}

function seen(): Seen {
  return { embeds: [], reranks: [], searches: [], asked: [] };
}

describe("planOf (feature-specs/12 § 7.2's table, as feature-specs/23 § 5.3 leaves it)", () => {
  const none = { chapter: null, section: null };

  it("searches the whole verified release in explain mode and always includes the sections the question names (D7)", () => {
    expect(planOf("explain", none, [], referencesOf("What does section 21.3 say?"))).toEqual({ scope: { chapters: [], verifiedOnly: true }, always: ["21.3"], limit: REFERENCED_MAX });
    expect(planOf("explain", none, [])).toEqual({ scope: { chapters: [], verifiedOnly: true }, always: [], limit: REFERENCED_MAX });
    expect(planOf("explain", none, [], referencesOf("How do retries work?")).always).toEqual([]);
  });

  it("orders what a question names: sections with a cue word, then bare ids, then each named chapter's opening section", () => {
    const plan = planOf("explain", none, [], referencesOf("Does 09.2 agree with chapter 12 and with section 21.3, or with section 21.3 only?"));
    expect(plan.always).toEqual(["21.3", "09.2", "12.1"]);
    expect(plan.limit).toBe(2);
    /* A section is named, so the whole release is searched even though a chapter is mentioned too. */
    expect(plan.scope.chapters).toEqual([]);
  });

  it("reads a chapter whole when the question names that chapter and no section", () => {
    const plan = planOf("explain", none, [], referencesOf("Which source does chapter 04 give for PagedAttention; 20.4–38.2% prior?"));
    expect(plan.scope).toEqual({ chapters: [4], verifiedOnly: true });
    expect(plan.always).toEqual(["04.1", "04.2", "04.3", "04.4", "04.5", "04.6", "04.7", "04.8", "04.9"]);
    expect(plan.limit).toBe(9);
  });

  it("searches the chapters a question names when it names several, with each one's opening section", () => {
    expect(planOf("explain", none, [], referencesOf("Do chapters 21 and 28 agree on retries?"))).toEqual({ scope: { chapters: [21, 28], verifiedOnly: true }, always: ["21.1", "28.1"], limit: REFERENCED_MAX });
  });

  it("reads no position: the same question plans the same set whatever the context carries", () => {
    const references = referencesOf("In section 20.3, what is the value?");
    expect(planOf("explain", { chapter: 35, section: parseSectionId("35.2") }, [], references)).toEqual(planOf("explain", none, [], references));
  });

  it("restricts compare to the two chapters and always includes both NN.1", () => {
    expect(planOf("compare", { ...none, chapters: [21, 26] }, [])).toEqual({ scope: { chapters: [21, 26], verifiedOnly: true }, always: ["21.1", "26.1"] });
    expect(() => planOf("compare", none, [])).toThrow(AppError);
  });

  it("restricts walk to the aid's chapter with the aid's own section, and lab to the lab's chapter with its NN.4", () => {
    expect(planOf("walk", { chapter: 37, section: parseSectionId("37.8") }, [])).toEqual({ scope: { chapters: [37], verifiedOnly: true }, always: ["37.8"] });
    expect(planOf("walk", { chapter: 21, section: parseSectionId("21.7") }, []).always).toEqual(["21.7"]);
    expect(planOf("walk", { chapter: 21, section: null }, []).always).toEqual(["21.8"]);
    expect(planOf("lab", { chapter: 9, section: null, labId: "lab-09" }, [])).toEqual({ scope: { chapters: [9], verifiedOnly: true }, always: ["09.4"] });
    /* A walk or a lab turn with no target is a defect of the caller, not a question to answer from the whole book. */
    expect(() => planOf("walk", none, [])).toThrow(AppError);
    expect(() => planOf("lab", { ...none, labId: "lab-09" }, [])).toThrow(AppError);
  });

  it("restricts brief to the release's own Part III, adds nothing, and refuses when it has none", () => {
    const plan = planOf("brief", none, [34, 35, 36, 37, 38, 39, 40], referencesOf("Brief me on section 37.8"));
    expect(plan.scope).toEqual({ chapters: [34, 35, 36, 37, 38, 39, 40], verifiedOnly: true });
    expect(plan.always).toEqual([]);
    expect(() => planOf("brief", none, [])).toThrow(AppError);
  });
});

describe("retrieve (feature-specs/12 § 7.2)", () => {
  const forty = Array.from({ length: CANDIDATES }, (_, i) => `${String(21 + (i % 8)).padStart(2, "0")}.${(i % 9) + 1}`);

  it("embeds the question, runs the scoped statement and hands over the re-ranked eight", async () => {
    const watched = seen();
    const anchors = ["26.2", "21.5", "14.3", "12.2", "09.2", "21.1", "30.4", "17.6", "21.3", "28.4"];
    const retrieved = await retrieve(request(), deps(anchors, watched));

    expect(watched.embeds).toEqual([request().question]);
    /* Sections only, forty candidates, the mode's scope, and the query vector the embedding produced. */
    expect(watched.searches).toHaveLength(1);
    expect(watched.searches[0].filters.type).toEqual(["section"]);
    expect(watched.searches[0].limit).toBe(CANDIDATES);
    expect(watched.searches[0].scope).toEqual({ chapters: [], verifiedOnly: true });
    expect(watched.searches[0].vector?.embedding).toEqual(EMBEDDING);
    /* Every candidate is re-ranked against the question, and eight survive. */
    expect(watched.reranks).toEqual([{ query: request().question, ids: anchors, topN: TOP_N }]);
    expect(retrieved.candidates).toBe(anchors.length);
    expect(retrieved.sections).toHaveLength(TOP_N + 1);
    expect(retrieved.sections.slice(0, TOP_N).map((section) => section.sectionId)).toEqual(anchors.slice(0, TOP_N));
    expect(retrieved.sections.map((section) => section.rank.final)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(retrieved.sections[0]).toMatchObject({ chapter: 26, layer: 2, version: "v1.0.0", verify: "PASSED", editionLang: "EN", truncated: false });
    expect(retrieved.sections[0].text).toBe("the prose of 26.2");
    expect(retrieved.sections[0].figureIds).toEqual(["F-26-01"]);
    expect(retrieved.sections[0].rank).toEqual({ lexicalPos: 1, vectorPos: 1, rerankScore: 1, final: 1 });
    expect(retrieved.sections[3].rank.vectorPos).toBeNull();
    expect(retrieved.timings).toEqual({ embedMs: 31, sqlMs: 11, rerankMs: 42, totalMs: retrieved.timings.totalMs });
    expect(retrieved.overBudget).toBe(false);
    expect(retrieved.vectorReady).toBe(true);
    /* One load for the candidates and the always-included section together. */
    expect(watched.asked).toHaveLength(1);
    expect(watched.asked[0]).toEqual([...anchors, "21.3"]);
  });

  it("names no ref on its two calls for an Assistant turn, and a research run's id for a person's run (feature-specs/48 § 5.3)", async () => {
    const refs: Array<string | null> = [];
    const anchors = ["21.1", "21.2"];
    const watching = (over: Partial<RetrieveDeps> = {}): RetrieveDeps => ({
      ...deps(anchors, seen()),
      embed: async (call) => {
        refs.push(call.ref);
        return { embedding: EMBEDDING, ms: 1 };
      },
      rerank: async (call, input) => {
        refs.push(call.ref);
        return { hits: input.documents.map((document, index) => ({ id: document.id, score: 1 - index / 100, truncated: false })), ms: 1 };
      },
      ...over,
    });
    await retrieve(request(), watching());
    expect(refs).toEqual([null, null]);
    refs.length = 0;
    const runId = "7d0c5a51-6f8e-4d0a-9d55-2b1f3c6a7e90";
    await retrieve(request({ ref: runId }), watching());
    expect(refs).toEqual([runId, runId]);
  });

  it("appends the section the question names as the ninth when the eight do not hold it, and does not duplicate it when they do", async () => {
    const dropped = await retrieve(request(), deps(forty, seen()));
    expect(dropped.sections).toHaveLength(TOP_N + 1);
    expect(dropped.sections.at(-1)?.sectionId).toBe("21.3");
    /* Appended, not re-ranked: no score, and its rank keeps whatever the statement said about it. */
    expect(dropped.sections.at(-1)?.rank.rerankScore).toBeNull();
    expect(dropped.sections.at(-1)?.rank.final).toBe(TOP_N + 1);

    /* The same query with 21.3 among the candidates, and the re-ranker putting it first. */
    const candidates = ["21.3", ...forty.slice(0, CANDIDATES - 1)];
    const kept = await retrieve(request(), deps(candidates, seen(), {}, { rerankOrder: candidates }));
    expect(kept.sections).toHaveLength(TOP_N);
    expect(kept.sections.filter((section) => section.sectionId === "21.3")).toHaveLength(1);
    expect(kept.sections[0].sectionId).toBe("21.3");
    expect(kept.sections[0].rank.rerankScore).toBe(1);
  });

  it("includes both chapters' NN.1 in compare mode, whatever the re-rank kept", async () => {
    const watched = seen();
    const anchors = ["21.3", "26.3", "21.5", "26.7"];
    const retrieved = await retrieve(request({ mode: "compare", context: { chapter: null, section: null, chapters: [21, 26] } }), deps(anchors, watched));
    expect(watched.searches[0].scope).toEqual({ chapters: [21, 26], verifiedOnly: true });
    expect(retrieved.sections.map((section) => section.sectionId)).toEqual([...anchors, "21.1", "26.1"]);
    expect(retrieved.sections.every((section) => section.chapter === 21 || section.chapter === 26)).toBe(true);
  });

  it("hands a section over once when the mode's always-included list names it twice", async () => {
    /* Compare mode given the same chapter twice names one `NN.1` twice; the set has no duplicates, of the eight or
       of each other (architecture § 12, unit 26c). */
    const watched = seen();
    const anchors = ["21.3", "21.5"];
    const retrieved = await retrieve(request({ mode: "compare", context: { chapter: null, section: null, chapters: [21, 21] } }), deps(anchors, watched));
    expect(retrieved.sections.map((section) => section.sectionId)).toEqual([...anchors, "21.1"]);
    expect(retrieved.sections.map((section) => section.rank.final)).toEqual([1, 2, 3]);
  });

  it("keeps the fused order with no scores when the re-ranker is unavailable (D8)", async () => {
    const watched = seen();
    const anchors = forty;
    const retrieved = await retrieve(
      request(),
      deps(anchors, watched, {
        rerank: async () => {
          throw new GatewayUnavailableError("connection", "the gateway is down");
        },
      }),
    );
    expect(retrieved.sections.slice(0, TOP_N).map((section) => section.sectionId)).toEqual(anchors.slice(0, TOP_N));
    expect(retrieved.sections.every((section) => section.rank.rerankScore === null)).toBe(true);
    expect(retrieved.timings.rerankMs).toBe(0);
    /* The vector half still ran, and the always-included section is still there. */
    expect(retrieved.vectorReady).toBe(true);
    expect(retrieved.sections.at(-1)?.sectionId).toBe("21.3");
  });

  it("runs the lexical half alone when the release is not vector-ready, without spending an embedding", async () => {
    const watched = seen();
    const retrieved = await retrieve(request(), deps(["21.3", "21.4"], watched, {}, { status: INDEXING }));
    expect(watched.embeds).toEqual([]);
    expect(watched.searches[0].vector).toBeNull();
    expect(retrieved.vectorReady).toBe(false);
    expect(retrieved.timings.embedMs).toBe(0);
    /* The lexical half alone: no hit carries a vector position (12 § 5). */
    expect(retrieved.sections.map((section) => section.rank.vectorPos)).toEqual([null, null]);
    expect(retrieved.sections.map((section) => section.rank.lexicalPos)).toEqual([1, 2]);
  });

  it("runs the lexical half alone when the embedding is refused, and raises anything else", async () => {
    const watched = seen();
    const refused = await retrieve(
      request(),
      deps(["21.3"], watched, {
        embed: async () => {
          throw new BudgetExceededError(new Date("2026-10-01T00:00:00.000Z"), "budget spent");
        },
      }),
    );
    expect(refused.vectorReady).toBe(false);
    expect(watched.searches[0].vector).toBeNull();
    expect(refused.sections).toHaveLength(1);

    await expect(
      retrieve(
        request(),
        deps(["21.3"], seen(), {
          embed: async () => {
            throw new AppError("GATEWAY_EMBED_DIMENSIONS", "the pin and the column disagree");
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "GATEWAY_EMBED_DIMENSIONS" });
  });

  it("keeps the fused eight when the re-ranker refuses the request, and the lexical half when the embedding does", async () => {
    /*
     * A 400/401/403/404/413 is the third typed refusal of spec 11 § 5.2 — an alias a key may not reach, a payload
     * the provider will not take (§ 7.1's document limit is the provider's and still owed, so a 40-document batch
     * goes whole) — and § 7.2 and D8 refuse the answer only when BOTH halves fail, never on one (review round 2,
     * 2026-09-24). The gateway module has already written its `refused` ledger row and span by then.
     */
    const rerankRefused = await retrieve(
      request(),
      deps(forty, seen(), {
        rerank: async () => {
          throw new GatewayRefusedError(413, "payload too large");
        },
      }),
    );
    expect(rerankRefused.sections).toHaveLength(TOP_N + 1);
    expect(rerankRefused.sections.slice(0, TOP_N).map((section) => section.sectionId)).toEqual(forty.slice(0, TOP_N));
    expect(rerankRefused.sections.every((section) => section.rank.rerankScore === null)).toBe(true);
    expect(rerankRefused.timings.rerankMs).toBe(0);
    expect(rerankRefused.vectorReady).toBe(true);
    expect(rerankRefused.sections.at(-1)?.sectionId).toBe("21.3");

    const watched = seen();
    const embedRefused = await retrieve(
      request(),
      deps(["21.3"], watched, {
        embed: async () => {
          throw new GatewayRefusedError(401, "key not allowed to access model");
        },
      }),
    );
    expect(embedRefused.vectorReady).toBe(false);
    expect(watched.searches[0].vector).toBeNull();
    expect(embedRefused.sections).toHaveLength(1);
    expect(embedRefused.sections[0].rank.vectorPos).toBeNull();
  });

  it("re-ranks nothing when the statement found nothing, and still hands over the always-included section", async () => {
    const watched = seen();
    const retrieved = await retrieve(request(), deps([], watched));
    expect(watched.reranks).toEqual([]);
    expect(retrieved.candidates).toBe(0);
    expect(retrieved.sections.map((section) => section.sectionId)).toEqual(["21.3"]);
    expect(retrieved.sections[0].rank).toEqual({ lexicalPos: null, vectorPos: null, rerankScore: null, final: 1 });
  });

  it("refuses a question that is empty or longer than the composer's cap", async () => {
    await expect(retrieve(request({ question: "   " }), deps([], seen()))).rejects.toMatchObject({ code: "RETRIEVE_QUESTION" });
    await expect(retrieve(request({ question: "a".repeat(801) }), deps([], seen()))).rejects.toMatchObject({ code: "RETRIEVE_QUESTION" });
  });
  it("hands over two of the sections a question names, and skips one the release does not have", async () => {
    const anchors = ["26.2", "21.5"];
    const three = await retrieve(request({ question: "Compare section 21.3, section 09.2 and section 12.4 on retries" }), deps(anchors, seen()));
    expect(three.sections.map((section) => section.sectionId)).toEqual([...anchors, "21.3", "09.2"]);

    /* 21.3 is not in this release: it is asked for, has no row, and the next two take the two places. */
    const base = deps(anchors, seen());
    const missing = await retrieve(
      request({ question: "Compare section 21.3, section 09.2 and section 12.4 on retries" }),
      { ...base, sections: async (releaseId, asked, scope) => (await base.sections?.(releaseId, asked, scope) ?? []).filter((found) => found.anchor !== "21.3") },
    );
    expect(missing.sections.map((section) => section.sectionId)).toEqual([...anchors, "09.2", "12.4"]);
  });

  it("adds nothing to a question that names nothing", async () => {
    const anchors = ["26.2", "21.5"];
    const retrieved = await retrieve(request({ question: "how does an idempotency key make a retry safe" }), deps(anchors, seen()));
    expect(retrieved.sections.map((section) => section.sectionId)).toEqual(anchors);
  });
  it("hands over a named chapter whole: the eight the re-rank kept and the one it did not", async () => {
    const watched = seen();
    const nine = ["04.1", "04.2", "04.3", "04.4", "04.5", "04.6", "04.7", "04.8", "04.9"];
    /* The statement found all nine and the re-rank puts the registry last, as the stub's overlap ranker did for four questions. */
    const retrieved = await retrieve(request({ question: "Which source does chapter 04 give for sliding-window attention?" }), deps(nine, watched));
    expect(watched.searches[0].scope).toEqual({ chapters: [4], verifiedOnly: true });
    expect(retrieved.sections.map((section) => section.sectionId)).toEqual(nine);
    expect(retrieved.sections.at(-1)?.rank.rerankScore).toBeNull();
  });
});
