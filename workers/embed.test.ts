import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { stubEmbedding } from "@/infra/gateway/stub/embed";
import { aliasesFromConfig, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import type { BudgetRowInput } from "@/lib/db/budget";
import type { EmbedReleaseStatus, SectionToEmbed } from "@/lib/db/search";
import { AppError } from "@/lib/errors";
import type { GatewayDeps } from "@/lib/gateway/client";
import { encryptKey } from "@/lib/gateway/keys";
import type { GatewaySpan } from "@/lib/gateway/span";
import { EMBED_MODEL_ID, EMBED_TARGET } from "@/lib/gateway/prices";
import { batchesOf, embedQuery, embedRelease, type EmbedJobDeps } from "@/workers/embed";

/*
 * The embedding job (feature-specs/12 § 4.2) and the query embedding (§ 4.3) against the stub gateway, with the three
 * content queries as in-memory doubles: the job's batching, its per-batch write, its resumability and the two failures
 * that stop it are all here without the database. The run against the real release is `npm run embed:release` (§ 12.2).
 */

const MASTER_KEY = "test-master-key-for-the-job";
const SECRET = "0123456789abcdef".repeat(4);
const NOW = new Date("2026-09-23T12:00:00.000Z");
const ALIASES = aliasesFromConfig(readFileSync(join(import.meta.dirname, "..", "infra", "gateway", "litellm.yaml"), "utf8"));
const RELEASE = "2026.09";

function section(chapter: number, layer: number): SectionToEmbed {
  return { sectionId: `id-${chapter}-${layer}`, anchor: `${chapter}.${layer}`, chapter, text: `${chapter}.${layer} a section about retries and idempotency keys` };
}

const SECTIONS: ReadonlyArray<SectionToEmbed> = [section(21, 1), section(21, 2), section(21, 3), section(28, 1), section(37, 8)];

describe("the embedding job", () => {
  let stub: RunningStub;
  const rows: BudgetRowInput[] = [];

  beforeAll(async () => {
    stub = await startStub({ masterKey: MASTER_KEY, aliases: ALIASES, port: 0, log: () => undefined, now: () => NOW });
  });
  afterAll(async () => {
    await stub.close();
  });

  async function mint(body: Record<string, unknown> = {}): Promise<string> {
    const res = await fetch(`${stub.url}/key/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ models: [...ALIASES.keys()], ...body }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { key: string }).key;
  }

  function gateway(key: string, overrides: Partial<GatewayDeps> = {}): GatewayDeps {
    return {
      baseUrl: stub.url,
      keySecret: SECRET,
      findKey: async () => ({ keyCiphertext: encryptKey(SECRET, key) }),
      append: async (row) => {
        rows.push(row);
      },
      log: () => undefined,
      fetch: globalThis.fetch,
      now: () => NOW,
      ...overrides,
    };
  }

  /** The three content queries as an in-memory table: `pending` shrinks as `write` fills it, as the release does. */
  function store(sections: ReadonlyArray<SectionToEmbed> = SECTIONS) {
    const written = new Map<string, { readonly embedding: ReadonlyArray<number>; readonly at: Date }>();
    const deps = (gatewayDeps: GatewayDeps): EmbedJobDeps => ({
      gateway: gatewayDeps,
      pending: async () => sections.filter((item) => !written.has(item.sectionId)),
      write: async (batch, now) => {
        for (const row of batch) written.set(row.sectionId, { embedding: row.embedding, at: now });
        return batch.length;
      },
      status: async (): Promise<EmbedReleaseStatus> => ({ sections: sections.length, embedded: written.size, model: EMBED_TARGET }),
    });
    return { written, deps };
  }

  it("cuts the pending sections into batches of the given size, in order", () => {
    expect(batchesOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batchesOf([1, 2], 5)).toEqual([[1, 2]]);
    expect(batchesOf([], 3)).toEqual([]);
    expect(() => batchesOf([1], 0)).toThrow(AppError);
    expect(() => batchesOf([1], 1.5)).toThrow(/whole number/);
  });

  it("embeds the first maxCharacters of a long section and counts what it cut (2026-09-25)", async () => {
    const key = await mint();
    const long = { ...section(21, 1), text: "x".repeat(50) };
    const short = { ...section(21, 2), text: "y".repeat(10) };
    const { deps } = store([long, short]);
    const sent: string[] = [];
    const seen = (gatewayDeps: GatewayDeps): GatewayDeps => ({
      ...gatewayDeps,
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body;
        if (typeof body === "string") for (const text of (JSON.parse(body) as { input: string[] }).input) sent.push(text);
        return gatewayDeps.fetch(input, init);
      },
    });

    const report = await embedRelease({ releaseId: RELEASE, principal: { userId: "u-1" }, batchSize: 5, maxCharacters: 20 }, deps(seen(gateway(key))));

    /* The long one reaches the model cut to the bound; the short one is untouched, and only the cut is counted. */
    expect(sent).toEqual(["x".repeat(20), "y".repeat(10)]);
    expect(report.truncated).toBe(1);
    expect(report.written).toBe(2);
  });

  it("embeds every pending section, one call and one write per batch, and reports the counts", async () => {
    const key = await mint();
    const { written, deps } = store();
    const before = rows.length;

    const report = await embedRelease({ releaseId: RELEASE, principal: { userId: "u-1" }, batchSize: 2, maxCharacters: 1_000_000 }, deps(gateway(key)));

    expect(report).toMatchObject({ releaseId: RELEASE, model: EMBED_TARGET, sections: 5, embedded: 5, written: 5, left: 0, batches: 3, stopped: null });
    expect(report.inputTokens).toBeGreaterThan(0);
    expect(written.size).toBe(5);
    expect(written.get("id-21-3")?.embedding).toEqual(stubEmbedding(section(21, 3).text));
    expect(written.get("id-21-3")?.at).toEqual(NOW);
    /* One EMBED row per batch, on the principal the caller named (feature-specs/12 § 4.2). */
    const written_rows = rows.slice(before);
    expect(written_rows).toHaveLength(3);
    expect(written_rows.every((row) => row.kind === "EMBED" && row.outcome === "ok" && row.ref === `release:${RELEASE}`)).toBe(true);
    expect(written_rows.every((row) => "userId" in row.principal)).toBe(true);
  });

  it("credits the rows the write reported, not the batch's size", async () => {
    /*
     * A section that left the release between the plan and the write is not progress: `written` and `left` are what
     * an operator reads, so they come from the statement's own row count (review round 2, 2026-09-24).
     */
    const key = await mint();
    const { written, deps } = store();
    const short = (gatewayDeps: GatewayDeps): EmbedJobDeps => {
      const base = deps(gatewayDeps);
      return { ...base, write: async (batch, now) => (await base.write(batch, now)) - 1 };
    };

    const report = await embedRelease({ releaseId: RELEASE, principal: { userId: "u-1" }, batchSize: 5, maxCharacters: 1_000_000 }, short(gateway(key)));

    expect(report.written).toBe(4);
    expect(report.left).toBe(1);
    /* The five vectors the batch carried are in the table; only the count the statement reported is credited. */
    expect(written.size).toBe(5);
    expect(report.embedded).toBe(5);
  });

  it("embeds nothing on a second run and only what is missing after that", async () => {
    const key = await mint();
    const { written, deps } = store();
    await embedRelease({ releaseId: RELEASE, principal: { userId: "u-1" }, batchSize: 5, maxCharacters: 1_000_000 }, deps(gateway(key)));
    const before = rows.length;

    const second = await embedRelease({ releaseId: RELEASE, principal: { userId: "u-1" }, batchSize: 5, maxCharacters: 1_000_000 }, deps(gateway(key)));
    expect(second).toMatchObject({ written: 0, batches: 0, left: 0, embedded: 5, stopped: null });
    expect(rows).toHaveLength(before);

    written.delete("id-28-1");
    const third = await embedRelease({ releaseId: RELEASE, principal: { userId: "u-1" }, batchSize: 5, maxCharacters: 1_000_000 }, deps(gateway(key)));
    expect(third).toMatchObject({ written: 1, batches: 1, left: 0, embedded: 5 });
    expect(written.has("id-28-1")).toBe(true);
  });

  it("stops on an unreachable gateway with the counts, and the next run completes the release", async () => {
    const key = await mint();
    const { written, deps } = store();
    let calls = 0;
    /* The third batch fails as `x-hb-stub-fail: 500` does, after the SDK's retries (§ 12.2). */
    const failing = gateway(key, {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        calls += 1;
        if (calls > 2) headers.set("x-hb-stub-fail", "500");
        return globalThis.fetch(input, { ...init, headers });
      },
    });

    const stopped = await embedRelease({ releaseId: RELEASE, principal: { userId: "u-1" }, batchSize: 1, maxCharacters: 1_000_000 }, deps(failing));
    expect(stopped.stopped?.reason).toBe("unavailable");
    expect(stopped.written).toBe(2);
    expect(stopped.left).toBe(3);
    expect(stopped.embedded).toBe(2);
    expect(rows.at(-1)).toMatchObject({ kind: "EMBED", outcome: "unavailable" });

    const finished = await embedRelease({ releaseId: RELEASE, principal: { userId: "u-1" }, batchSize: 5, maxCharacters: 1_000_000 }, deps(gateway(key)));
    expect(finished).toMatchObject({ written: 3, left: 0, embedded: 5, stopped: null });
    expect(written.size).toBe(5);
  });

  it("stops at the budget with the counts, having written what it embedded", async () => {
    /* A key whose budget is spent refuses before the provider (spec 11 § 3.4); nothing is embedded. */
    const key = await mint({ max_budget: 0, budget_duration: "1mo" });
    const { written, deps } = store();

    const report = await embedRelease({ releaseId: RELEASE, principal: { organisationId: "org-1" }, batchSize: 2, maxCharacters: 1_000_000 }, deps(gateway(key)));
    expect(report.stopped?.reason).toBe("budget");
    expect(report).toMatchObject({ written: 0, left: 5, embedded: 0, batches: 0 });
    expect(written.size).toBe(0);
    expect(rows.at(-1)).toMatchObject({ kind: "EMBED", outcome: "budget" });
  });

  it("raises anything that is not a failing service, so a defect is not recorded as progress", async () => {
    const key = await mint();
    const { deps } = store();
    const wrongShape = gateway(key, {
      fetch: async () => new Response(JSON.stringify({ data: [{ object: "embedding", index: 0, embedding: [0, 1] }], model: EMBED_MODEL_ID }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(embedRelease({ releaseId: RELEASE, principal: { userId: "u-1" }, batchSize: 1, maxCharacters: 1_000_000 }, deps(wrongShape))).rejects.toMatchObject({ code: "GATEWAY_EMBED_DIMENSIONS" });
  });

  it("embeds one query as its own call, the vector the stored ones are compared with", async () => {
    const key = await mint();
    const before = rows.length;

    const spans: GatewaySpan[] = [];
    const embedded = await embedQuery({ guide: null, principal: { organisationId: "org-1" }, traceId: "e".repeat(32), ref: null }, "idempotency keys", gateway(key, { log: (span) => spans.push(span) }));
    /* the query's embedding names itself, whoever asks for it (49 § 6.2) */
    expect(spans.map((span) => span["hb.agent"])).toEqual(["embed.query"]);

    expect(embedded.embedding).toEqual(stubEmbedding("idempotency keys"));
    expect(embedded.embedding).toHaveLength(1024);
    expect(embedded.modelId).toBe(EMBED_MODEL_ID);
    expect(embedded.ms).toBeGreaterThanOrEqual(0);
    expect(rows.slice(before)).toMatchObject([{ kind: "EMBED", outcome: "ok", ref: null, principal: { organisationId: "org-1" } }]);
  });

  it("raises the gateway's refusals to the caller, which is how the search page falls back to lexical", async () => {
    const spent = await mint({ max_budget: 0, budget_duration: "1mo" });
    await expect(embedQuery({ guide: null, principal: { organisationId: "org-1" }, traceId: "e".repeat(32), ref: null }, "idempotency", gateway(spent))).rejects.toMatchObject({ code: "GATEWAY_BUDGET" });
  });
});