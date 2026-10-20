import { beforeAll, describe, expect, it } from "vitest";

import type { SessionUser } from "@/lib/auth/session";
import { EMBED_MODEL_ID } from "@/lib/gateway/prices";
import { getPrisma } from "@/lib/db/client";
import { embedReleaseStatus, getSearchData, retrievedSections, vectorReady } from "@/lib/db/search";
import { env } from "@/lib/env";
import { EMPTY_FILTERS, parseSearchParams, type SearchFilters } from "@/lib/search/filters";
import { searchRelease, type QueryVector } from "@/lib/search/hybrid";
import type { Principal } from "@/lib/schemas/gateway";
import { snippetViolations, type SearchData } from "@/lib/schemas/search";
import { defaultWorkersDeps, ROUTE_TIMEOUT_MS, WorkersUnavailableError, type WorkersClientDeps } from "@/lib/workers/client";

/*
 * Search against the ingested release (feature-specs/06 § 12.2, 12 § 12.4). Skipped
 * without DATABASE_URL. The fused rank is tested here rather than beside the module
 * because reciprocal-rank fusion is the statement itself (12 § 5): a TypeScript copy
 * of the formula would be a second source of truth for the rank.
 */
const hasDatabase = env.DATABASE_URL !== undefined;
const q = (query: string, over: Partial<SearchFilters> = {}): SearchFilters => ({ ...EMPTY_FILTERS, q: query, ...over });

/*
 * The EN page as this file drives it. The configured anonymous payer of 12 § 6 is `null` unless a case names one, so
 * the vector state a case asserts is the case's own and not the machine's `GATEWAY_ANONYMOUS_PRINCIPAL`.
 */
const load = (filters: SearchFilters, user: SessionUser | null = null, workers: WorkersClientDeps = defaultWorkersDeps(), anonymous: Principal | null = null): Promise<SearchData> =>
  getSearchData("en", filters, user, 0, workers, anonymous);

describe.skipIf(!hasDatabase)("search against the release database", () => {
  /*
   * The fused-rank and vector-state cases need the release's own vectors (12 § 4.2). The precondition is stated once
   * and loudly: a release that was migrated but never embedded fails the file with the command that fixes it, rather
   * than letting three cases return early and be counted as passed (rules § 7.13, § 8.2; review round 2, 2026-09-24).
   * "Vector-ready" is `embedReleaseStatus` + `vectorReady`, the same reading the page and retrieval use.
   */
  beforeAll(async () => {
    const release = (await load(EMPTY_FILTERS)).release.id;
    if (!vectorReady(await embedReleaseStatus(release))) {
      expect.fail("the release is not vector-ready: run npm run embed:release -- --org <id> --batch 32 (feature-specs/12 § 4.2)");
    }
  });

  it("finds idempotency in sections, labs and rows, chapter 21 among them, with marked snippets", async () => {
    const data = await load(q("idempotency", { n: 50 }));
    expect(data.count).toBeGreaterThan(5);
    const kinds = new Set(data.hits.map((h) => h.kind));
    expect(kinds.has("section")).toBe(true);
    expect(kinds.has("lab")).toBe(true);
    expect(kinds.has("row")).toBe(true);
    expect(data.hits.some((h) => h.chapter === 21)).toBe(true);
    expect(data.hits.every((h) => snippetViolations(h.snippet).length === 0)).toBe(true);
    expect(data.hits.some((h) => h.snippet.includes("<mark>"))).toBe(true);
    expect(data.terms.query).toEqual(["idempot"]);
    expect(data.terms.matched.some((w) => w.startsWith("idempot"))).toBe(true);
    expect(data.stopWordsOnly).toBe(false);
    expect(data.facets.type.reduce((a, f) => a + f.count, 0)).toBe(data.count);
    expect(data.facets.age.map((f) => f.value)).toEqual(["d30", "d90", "stale"]);
    expect(data.index.sections).toBe(362);
    /* `Ask about <query>` opens the dock over these results, holding the query (feature-specs/24 § 6.2). */
    expect(data.actions.askHref).toBe("/en/search?q=idempotency&n=50&ask=1&draft=idempotency");
    expect(data.actions.lab?.href).toMatch(/^\/en\/labs\/lab-\d{2}$/);
    expect(data.timings.vectorMs).toBeNull();
  });

  it("narrows with each filter and keeps the other groups' counts honest", async () => {
    const all = await load(q("idempotency", { n: 200 }));
    const layer2 = await load(q("idempotency", { n: 200, layer: [2] }));
    expect(layer2.count).toBeLessThan(all.count);
    expect(layer2.hits.every((h) => h.layer === 2)).toBe(true);
    expect(layer2.facets.layer.find((f) => f.value === "2")?.count).toBe(layer2.count);
    expect(layer2.facets.labsWithoutLayer).toBe(all.facets.type.find((f) => f.value === "lab")?.count ?? 0);
    const labs = await load(q("idempotency", { n: 200, type: ["lab"] }));
    expect(labs.hits.every((h) => h.kind === "lab" && h.layer === null && h.tiers.includes("DERIVED"))).toBe(true);
    const tier = await load(q("idempotency", { n: 200, tier: ["VENDOR"] }));
    expect(tier.hits.every((h) => h.tiers.includes("VENDOR"))).toBe(true);
    const part = await load(q("idempotency", { n: 200, part: ["P2"] }));
    expect(part.hits.every((h) => h.chapter >= 16 && h.chapter <= 33)).toBe(true);
    const none = await load(q("idempotency", { part: ["P0"], type: ["lab"] }));
    expect(none.count).toBe(0);
    expect(none.hits).toEqual([]);
  });

  it("sorts by relevance, book order and verification", async () => {
    const rel = await load(q("workflow", { n: 30 }));
    const ranks = rel.hits.map((h) => h.rank);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    const book = await load(q("workflow", { n: 30, sort: "book" }));
    const chapters = book.hits.map((h) => h.chapter);
    expect([...chapters].sort((a, b) => a - b)).toEqual(chapters);
    const verified = await load(q("workflow", { n: 30, sort: "verified" }));
    expect(verified.hits.length).toBe(book.hits.length);
  });

  it("pages with n and handles empty, stop-word and hostile queries", async () => {
    const eight = await load(q("model"));
    expect(eight.hits).toHaveLength(Math.min(8, eight.count));
    const more = await load(q("model", { n: 23 }));
    expect(more.hits).toHaveLength(Math.min(23, more.count));
    const empty = await load(EMPTY_FILTERS);
    expect(empty.count).toBe(0);
    expect(empty.hits).toEqual([]);
    expect(empty.facets.type.reduce((a, f) => a + f.count, 0)).toBeGreaterThan(700);
    const stop = await load(q("the of"));
    expect(stop.stopWordsOnly).toBe(true);
    expect(stop.count).toBe(0);
    for (const hostile of ['"', "(", "-word", "a or b", "'; drop table", "idempotency -key", '"exact phrase"']) {
      const data = await load(q(hostile));
      expect(data.count).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * A section's own stored vector as a query vector: the nearest thing to itself is itself (12 § 12.4). The
   * `beforeAll` above already refused a release without vectors, so a missing one here is a missing section and
   * fails by name rather than returning null for a case to skip over.
   */
  async function vectorOf(anchor: string): Promise<QueryVector> {
    const rows = await getPrisma().$queryRaw<ReadonlyArray<{ readonly embedding: string }>>`
      SELECT s.embedding::text AS embedding
      FROM "Section" s
      JOIN "ChapterVersion" cv ON cv.id = s."chapterVersionId"
      JOIN "Release" r ON r.id = cv."releaseId" AND r."isCurrent"
      WHERE s.anchor = ${anchor} AND s.embedding IS NOT NULL`;
    const raw = rows[0];
    if (raw === undefined) expect.fail(`section ${anchor} of the current release holds no vector (feature-specs/12 § 4.2)`);
    return { embedding: JSON.parse(raw.embedding) as ReadonlyArray<number>, ms: 7 };
  }

  it("fuses the vector half by reciprocal rank: a section's own vector ranks it first, labs keep their lexical rank", async () => {
    const release = (await load(EMPTY_FILTERS)).release.id;
    const vector = await vectorOf("21.3");
    const filters = q("idempotency", { n: 50 });
    const fused = await searchRelease(release, filters, 50, vector);
    const lexical = await searchRelease(release, filters, 50, null);

    /* 21.3 is its own nearest neighbour; which hit leads is the fusion of both halves, not the vector half alone. */
    expect(fused.hits.find((h) => h.id === "21.3")?.vector_pos).toBe(1);
    expect(fused.hits[0]?.kind).toBe("section");
    expect(fused.vectorMs).toBe(7);
    expect(lexical.vectorMs).toBeNull();
    /* Every hit's rank is the sum of the halves that matched it, and the page is ordered by it. */
    for (const hit of fused.hits) {
      const expected = (hit.lexical_pos === null ? 0 : 1 / (60 + hit.lexical_pos)) + (hit.vector_pos === null ? 0 : 1 / (60 + hit.vector_pos));
      expect(hit.rank).toBeCloseTo(expected, 12);
    }
    expect([...fused.hits].sort((a, b) => b.rank - a.rank).map((h) => h.id)).toEqual(fused.hits.map((h) => h.id));
    /* A section in both halves outranks one in the lexical half alone at the same lexical position. */
    const both = fused.hits.find((h) => h.lexical_pos !== null && h.vector_pos !== null);
    const lexicalOnly = fused.hits.find((h) => h.lexical_pos !== null && h.vector_pos === null);
    expect(both).toBeDefined();
    expect(lexicalOnly).toBeDefined();
    if (both !== undefined && lexicalOnly !== undefined && both.lexical_pos !== null && lexicalOnly.lexical_pos !== null) {
      expect(both.rank).toBeGreaterThan(1 / (60 + both.lexical_pos));
    }
    /* Labs and source rows have no embedding in Phase 2: lexical rank alone (12 § 5). */
    expect(fused.hits.filter((h) => h.kind !== "section").every((h) => h.vector_pos === null)).toBe(true);
    /* The fused set is a superset of the lexical one, and so are the facets and the total. */
    const lexicalIds = new Set(lexical.hits.map((h) => `${h.kind}:${h.id}`));
    const fusedIds = new Set(fused.hits.map((h) => `${h.kind}:${h.id}`));
    expect([...lexicalIds].every((id) => fusedIds.has(id))).toBe(true);
    expect(fused.total).toBeGreaterThanOrEqual(lexical.total);
    for (const facet of ["part", "layer", "tier", "type"] as const) {
      for (const row of lexical.facets[facet]) {
        expect(fused.facets[facet].find((f) => f.value === row.value)?.count ?? 0).toBeGreaterThanOrEqual(row.count);
      }
    }
  });

  it("lets a section the lexical half did not match enter the set, and stays inside the page budget", async () => {
    const release = (await load(EMPTY_FILTERS)).release.id;
    const vector = await vectorOf("21.3");
    /* A query no section holds: without the vector half nothing answers it, with it the 50 nearest do (12 § 5). */
    const filters = q("kryptonite", { n: 50 });
    const lexical = await searchRelease(release, filters, 50, null);
    expect(lexical.total).toBe(0);
    const fused = await searchRelease(release, filters, 50, vector);
    expect(fused.total).toBe(50);
    expect(fused.hits.every((h) => h.kind === "section" && h.lexical_pos === null && h.vector_pos !== null)).toBe(true);
    expect(fused.hits[0]?.id).toBe("21.3");
    expect(fused.lexicalMs).toBeLessThan(500);
    const filtered = await searchRelease(release, q("kryptonite", { n: 50, part: ["P2"] }), 50, vector);
    expect(filtered.total).toBeLessThan(fused.total);
    expect(filtered.hits.every((h) => h.chapter >= 16 && h.chapter <= 33)).toBe(true);
  });

  it("gives a query with no lexeme zero hits even with a vector, so the stop-word state stays reachable", async () => {
    const release = (await load(EMPTY_FILTERS)).release.id;
    const vector = await vectorOf("21.3");
    /*
     * 06 § 5.2: "an empty or stop-word-only query yields zero hits and the page says so". `websearch_to_tsquery`
     * returns an EMPTY but NOT NULL tsquery for such a query, so the statement gates `vec` on the tsquery carrying a
     * lexeme (review round 2, 2026-09-24); without that gate these 0 were the release's 50 nearest sections and
     * `search.empty.stop` could never render. Asserted beside the `kryptonite` case above, whose 50 must stay 50:
     * the two rules are the statement's, and neither may be traded for the other.
     */
    const stop = await searchRelease(release, q("the of and", { n: 50 }), 50, vector);
    expect(stop.total).toBe(0);
    expect(stop.hits).toEqual([]);
    expect(stop.tsq).toBe("");
    /* The vector half was still asked for and still measured: the lexemes are only known inside the statement. */
    expect(stop.vectorMs).toBe(7);
    /* A reader on the vector-ready page therefore still sees the stop-word note, with a count of 0. */
    const page = await load(q("the of and", { n: 50 }));
    expect(page.count).toBe(0);
    expect(page.stopWordsOnly).toBe(true);
  });

  /*
   * The candidate set retrieval asks for (12 § 7.2): the statement restricted to a mode's chapters and to the
   * chapters whose VERIFY passed, and the loader that reads those sections' text, figures and version.
   */
  it("restricts the statement to a scope's chapters and to verified chapters", async () => {
    const release = (await load(EMPTY_FILTERS)).release.id;
    const filters = q("workflow", { n: 40, type: ["section"] });
    const whole = await searchRelease(release, filters, 40, null);
    const two = await searchRelease(release, filters, 40, null, { chapters: [21, 26], verifiedOnly: true });
    expect(two.hits.length).toBeGreaterThan(0);
    expect(two.hits.every((h) => h.chapter === 21 || h.chapter === 26)).toBe(true);
    expect(two.total).toBeLessThan(whole.total);
    /* The totals and the facets are of the scope, not of the release. */
    expect(two.total).toBe(two.hits.length);
    expect(two.facets.part.every((row) => row.value === "P2")).toBe(true);

    /* Part III is unverified in this release, so a verified-only scope of it is empty (12 § 7.2). */
    const partThree = await searchRelease(release, q("model", { n: 40, type: ["section"] }), 40, null, { chapters: [34, 35, 36, 37, 38, 39, 40], verifiedOnly: true });
    expect(partThree.total).toBe(0);
    const unverifiedAllowed = await searchRelease(release, q("model", { n: 40, type: ["section"] }), 40, null, { chapters: [34, 35, 36, 37, 38, 39, 40], verifiedOnly: false });
    expect(unverifiedAllowed.total).toBeGreaterThan(0);
    /* No unverified chapter reaches a verified-only candidate set, however well it matches. */
    const verifiedRelease = await searchRelease(release, q("model", { n: 200, type: ["section"] }), 200, null, { chapters: [], verifiedOnly: true });
    expect(verifiedRelease.hits.every((h) => h.chapter < 34)).toBe(true);
    expect(verifiedRelease.hits.every((h) => h.verify === "PASSED")).toBe(true);
  });

  it("loads a retrieved section's text, figures and version, and drops one outside the scope", async () => {
    const release = (await load(EMPTY_FILTERS)).release.id;
    const rows = await retrievedSections(release, ["21.3", "26.3", "34.8"], { chapters: [], verifiedOnly: true });
    const ids = rows.map((row) => row.anchor);
    expect(ids).toContain("21.3");
    expect(ids).toContain("26.3");
    /* 34.8 belongs to an unverified chapter: never handed to a model (§ 7.2). */
    expect(ids).not.toContain("34.8");
    const section = rows.find((row) => row.anchor === "21.3");
    expect(section).toMatchObject({ chapter: 21, layer: 3, verify: "PASSED" });
    expect(section?.title.length).toBeGreaterThan(0);
    expect(section?.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(section?.text.length).toBeGreaterThan(200);
    /* The plain text a model reads, never the HTML of the reader. */
    expect(section?.text).not.toContain("<p>");
    expect(section?.figureIds.length).toBeGreaterThan(0);
    expect(section?.figureIds.every((id) => /^F-\d{2}-\d{2,3}$/.test(id))).toBe(true);

    const scoped = await retrievedSections(release, ["21.3", "26.3"], { chapters: [21], verifiedOnly: true });
    expect(scoped.map((row) => row.anchor)).toEqual(["21.3"]);
    expect(await retrievedSections(release, [], { chapters: [], verifiedOnly: true })).toEqual([]);
  });

  const READER: SessionUser = { id: "u-search", organisationId: "org-search", role: "READER", displayName: "A reader", locale: "en", identityVerified: false, parts: [], sessionId: null };

  /** The workers' side of the page's vector half as a double: the route is the only thing the loader calls (12 § 6). */
  function workers(handler: (body: { readonly text: string; readonly principal: unknown }) => Promise<Response>, calls: { count: number }): WorkersClientDeps {
    return {
      baseUrl: "http://workers.test",
      token: "test-token",
      timeouts: ROUTE_TIMEOUT_MS,
      fetch: async (_input, init) => {
        calls.count += 1;
        return handler(JSON.parse(String(init?.body)) as { text: string; principal: unknown });
      },
    };
  }

  it("shows the vector half as ok when the workers answer, and as unavailable when they do not", async () => {
    const vector = await vectorOf("21.3");
    const calls = { count: 0 };
    const answering = workers(
      async (body) => {
        expect(body).toEqual({ text: "idempotency", principal: { organisationId: "org-search" } });
        return new Response(JSON.stringify({ embedding: vector.embedding, modelId: EMBED_MODEL_ID, ms: 4 }), { status: 200, headers: { "content-type": "application/json" } });
      },
      calls,
    );
    const fused = await load(q("idempotency", { n: 50 }), READER, answering);
    expect(calls.count).toBe(1);
    expect(fused.vector).toBe("ok");
    expect(fused.timings.vectorMs).toBeGreaterThanOrEqual(0);
    expect(fused.timings.totalMs).toBeLessThan(500);
    const lexical = await load(q("idempotency", { n: 50 }), null, answering);
    expect(lexical.vector).toBe("unavailable");
    expect(lexical.timings.vectorMs).toBeNull();
    /* A signed-out reader with no configured payer has no principal, so nothing was asked of the workers. */
    expect(calls.count).toBe(1);
    expect(fused.count).toBeGreaterThan(lexical.count);
    expect(fused.hits.map((h) => h.id)).not.toEqual(lexical.hits.map((h) => h.id));

    /* The workers stopped, refusing, or too slow: the page is the lexical one and says so (D6). */
    const stopped = { count: 0 };
    const down = await load(q("idempotency", { n: 50 }), READER, workers(async () => {
      throw new WorkersUnavailableError("connection", "/embed/query: ECONNREFUSED");
    }, stopped));
    expect(stopped.count).toBe(1);
    expect(down.vector).toBe("unavailable");
    expect(down.timings.vectorMs).toBeNull();
    expect(down.count).toBe(lexical.count);
    const refused = await load(q("idempotency", { n: 50 }), READER, workers(async () => new Response(JSON.stringify({ code: "GATEWAY_BUDGET", message: "Budget has been exceeded!", traceId: "a".repeat(32) }), { status: 402, headers: { "content-type": "application/json" } }), { count: 0 }));
    expect(refused.vector).toBe("unavailable");
    expect(refused.timings.vectorMs).toBeNull();
  });

  /* Andre's answer of 2026-09-24: the vector half is for everyone, paid for by the principal the environment names. */
  it("runs the vector half for a signed-out reader when an anonymous principal is configured", async () => {
    const vector = await vectorOf("21.3");
    const calls = { count: 0 };
    const answering = workers(
      async (body) => {
        expect(body).toEqual({ text: "idempotency", principal: { organisationId: "org-anon" } });
        return new Response(JSON.stringify({ embedding: vector.embedding, modelId: EMBED_MODEL_ID, ms: 4 }), { status: 200, headers: { "content-type": "application/json" } });
      },
      calls,
    );
    const configured = await load(q("idempotency", { n: 50 }), null, answering, { organisationId: "org-anon" });
    expect(calls.count).toBe(1);
    expect(configured.vector).toBe("ok");
    expect(configured.timings.vectorMs).toBeGreaterThanOrEqual(0);
    expect(configured.timings.totalMs).toBeLessThan(500);
    expect(configured.signedIn).toBe(false);
    /* The same page for the same reader without the variable: the lexical one, and no call made. */
    const unset = await load(q("idempotency", { n: 50 }), null, answering);
    expect(calls.count).toBe(1);
    expect(unset.vector).toBe("unavailable");
    expect(configured.count).toBeGreaterThan(unset.count);
  });

  it("answers 20 varied queries under the 500 ms budget each", async () => {
    const release = (await load(EMPTY_FILTERS)).release.id;
    const queries = ["idempotency", "workflow", "retry", "token", "attention", "sensor", "budget", "Temporal", "embedding", "regulation", "evaluation", "cache", "quantization", "memory", "audit", "gateway", "backoff", "approval", "timeout", "lab"];
    const vector = await vectorOf("21.3");
    const times: number[] = [];
    for (const query of queries) {
      const lexical = await searchRelease(release, parseSearchParams({ q: query }), 8, null);
      times.push(lexical.lexicalMs);
      /* The same twenty with the vector half on: the fused statement is measured too (12 § 12.4). */
      const fused = await searchRelease(release, parseSearchParams({ q: query }), 8, vector);
      times.push(fused.lexicalMs);
    }
    expect(Math.max(...times)).toBeLessThan(500);
  });
});
