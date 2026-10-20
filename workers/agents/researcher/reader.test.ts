import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FIXTURE_PAGES, FOUND_CLAIM, INJECTED_SENTENCE, INJECTION_MARKER } from "@/infra/gateway/stub/research";
import { aliasesFromConfig, startStub } from "@/infra/gateway/stub/server";
import type { BudgetRowInput } from "@/lib/db/budget";
import type { ResearchSection } from "@/lib/db/research";
import type { GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { encryptKey } from "@/lib/gateway/keys";
import { webSearchFeeUsd } from "@/lib/gateway/prices";
import { loadGuidePart } from "@/lib/guides/load";
import { RUBRIC_V1_2 } from "@/tests/fixtures/rubric";

import { assembleReader, parseFindings, read, readerRequestOf, renderTiers, type ReaderDeps, type ReaderInput, type ReadInput } from "./reader";

/*
 * The reader (feature-specs/41 § 6, § 11.2, § 11.3, § 11.7, § 11.9) on the stub gateway, started in this process: the
 * prompt in its five slots with the guide part and the rubric's tiers cached first; the request with the two server
 * tools and their limits and no client tool; the canary's second half — a marker word that was in the question is in
 * no byte of the reader's request, of any search the stub logged or of any address it fetched, because the input has no
 * field for it; the stub's fixtures parsed strictly; a paused turn continued as one attempt; the injection page's
 * finding citing an address no block returned; the agent's one failure named; a budget refusal thrown.
 */

const GUIDE = loadGuidePart("researcher", "v1.0", "reader");
const RUBRIC = { version: "v1.2", appliesAt: "2026-07-01", tiers: RUBRIC_V1_2.tiers, chips: { PRIMARY: "B", VENDOR: "C", ANALYST: "D", PRACTITIONER: "E", ILLUSTRATIVE: null, DERIVED: "A", OPEN: "U" } } as const;
const TRACE = "0123456789abcdef0123456789abcdef";
const RUN = "33333333-3333-4333-8333-333333333333";
const MARKER = "zebrafinch-7731";
const BRIEF = "Look for the current recommended practice on idempotency keys and their retention window, and whether a revision since the section's verification date changes the figures it cites.";
const SECTION: ResearchSection = {
  id: "21.3",
  chapter: 21,
  version: "v1.0.0",
  title: "Idempotency keys",
  text: "A retried write without a key is a second write. Keep the key for 24 hours.",
  verifiedOn: new Date("2026-03-04T00:00:00Z"),
  figures: [{ id: "F-21-05", label: "expected work redone", valueText: "45%", unit: null, tier: "ANALYST", fastMoving: true, verifiedOn: new Date("2026-03-01T00:00:00Z"), sourceRow: "21.9 r4" }],
  rows: [{ id: "21.9 r4", claim: "Retry storms after a deploy", citation: "Vendor incident review", url: "https://vendor.example/incident", tier: "VENDOR", verifiedOn: new Date("2026-03-01T00:00:00Z"), fastMoving: true }],
};

const promptOf = (over: Partial<ReaderInput> = {}): ReaderInput => ({ guide: GUIDE, rubric: RUBRIC, today: "2026-10-10", sections: [SECTION], brief: BRIEF, ...over });
const inputOf = (prompt: ReaderInput = promptOf()): ReadInput => ({ prompt, call: { principal: { organisationId: "org-research" }, traceId: TRACE, ref: RUN } });

let stub: Awaited<ReturnType<typeof startStub>>;
let key = "";
const keySecret = randomBytes(32).toString("hex");
const rows: BudgetRowInput[] = [];
const bodies: string[] = [];
const stubLog: string[] = [];

function depsOf(headers: Record<string, string> = {}, overrides: Partial<GatewayDeps> = {}): ReaderDeps {
  return {
    gateway: {
      baseUrl: stub.url,
      keySecret,
      findKey: async () => ({ keyCiphertext: encryptKey(keySecret, key) }),
      append: async (row) => {
        rows.push(row);
      },
      log: () => undefined,
      fetch: async (input, init) => {
        const merged = new Headers(init?.headers);
        for (const [name, value] of Object.entries(headers)) merged.set(name, value);
        if (typeof init?.body === "string") bodies.push(init.body);
        return globalThis.fetch(input, { ...init, headers: merged });
      },
      now: () => new Date("2026-10-10T12:00:00Z"),
      ...overrides,
    },
  };
}

beforeAll(async () => {
  const masterKey = randomBytes(24).toString("hex");
  const aliases = aliasesFromConfig(readFileSync(join(process.cwd(), "infra", "gateway", "litellm.yaml"), "utf8"));
  stub = await startStub({ masterKey, aliases, port: 0, log: (line) => stubLog.push(line) });
  const minted = await fetch(`${stub.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" }, body: JSON.stringify({ models: [...aliases.keys()], max_budget: 1_000 }) });
  key = ((await minted.json()) as { key: string }).key;
}, 60_000);

afterAll(async () => {
  await stub.close();
});

describe("the reader's prompt", () => {
  it("puts the guide part and the rubric's tiers first, cached together, then today, the sections and the brief", () => {
    const prompt = assembleReader(promptOf());
    expect(prompt.system).toEqual([
      { type: "text", text: GUIDE.prefix },
      { type: "text", text: renderTiers(RUBRIC), cache_control: { type: "ephemeral" } },
    ]);
    expect(renderTiers(RUBRIC)).toContain("rubric v1.2 (applies from 2026-07-01)\ntiers by base score, strongest first:\nA: base 100\nB: base 85\nC: base 70 (the vendor's own page at best)\nD: base 60");
    const content = prompt.messages[0].content;
    expect(content.startsWith("today: 2026-10-10\n\n<section id=\"21.3\"")).toBe(true);
    expect(content).toContain('figures: F-21-05 "expected work redone" 45% (tier D, verified 2026-03-01, fast-moving, row 21.9 r4)');
    expect(content).toContain("21.9 r4 · tier C · verified 2026-03-01");
    expect(content.endsWith(`<brief>\n${BRIEF}\n</brief>`)).toBe(true);
    /* without a published rubric the guide's own tier list stands alone, cached */
    expect(assembleReader(promptOf({ rubric: null })).system).toEqual([{ type: "text", text: GUIDE.prefix, cache_control: { type: "ephemeral" } }]);
  });

  it("holds the two server tools with ten uses each and no client tool (41 § 11.2)", () => {
    const { call, request } = readerRequestOf(inputOf());
    expect(call.serverTools).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 10 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 },
    ]);
    expect(request).not.toHaveProperty("tools");
    expect(call).toMatchObject({ purpose: "research", alias: "hb-frontier", guide: { agent: "researcher", version: "v1.0", sha256: GUIDE.sha256 }, ref: RUN });
    expect(request.model).toBe("hb-frontier");
    expect(request.max_tokens).toBe(16_000);
    expect(request.output_config).toEqual({ effort: "medium" });
  });
});

describe("parseFindings", () => {
  it("takes the guide's envelope, an empty list included, leaves each finding's shape to the validation, and refuses an envelope with a key the guide did not name — without echoing the key", () => {
    expect(parseFindings('{"findings":[]}')).toEqual({ ok: true, output: { findings: [] } });
    const finding = { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: "x", placeAfter: "end", fastMoving: true }, sources: [{ url: "https://a.example/" }], note: "n" };
    expect(parseFindings(`\`\`\`json\n${JSON.stringify({ findings: [finding] })}\n\`\`\``)).toMatchObject({ ok: true });
    expect(parseFindings("I found nothing.")).toEqual({ ok: false, reason: "the reader's output is not JSON" });
    /* one finding of another shape is that finding's fault (validation's PROPOSAL), not the run's */
    expect(parseFindings(JSON.stringify({ findings: [{ ...finding, proposal: { kind: "SET_VALUE", after: "45%", unit: null } }, finding] }))).toMatchObject({ ok: true });
    expect(parseFindings(JSON.stringify({ findings: "none" }))).toMatchObject({ ok: false });
    const stranger = parseFindings(JSON.stringify({ findings: [], zqx_marker_key: "copied" }));
    expect(stranger).toEqual({ ok: false, reason: "the reader's output has a key the guide did not name" });
    expect(JSON.stringify(stranger)).not.toContain("zqx_marker_key");
  });
});

describe("read against the stub", () => {
  it("reads the stub's finding with the pages its tools saw, counts the search and the fetch, and writes the RESEARCH row with the search's fee", async () => {
    rows.length = 0;
    bodies.length = 0;
    const answer = await read(inputOf(), depsOf());
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.output.findings).toHaveLength(1);
    expect(answer.output.findings[0]).toMatchObject({ anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: FOUND_CLAIM }, sources: [{ url: FIXTURE_PAGES.standard.url }] });
    expect(answer.pages).toEqual([FIXTURE_PAGES.standard.url, FIXTURE_PAGES.forum.url]);
    expect(answer).toMatchObject({ searches: 1, fetches: 1, continuations: 0, model: "claude-opus-5" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "RESEARCH", alias: "hb-frontier", outcome: "ok", ref: RUN, principal: { organisationId: "org-research" } });
    expect(rows[0].costUsd).toBeGreaterThan(webSearchFeeUsd(1));
  });

  it("carries nothing of the asker: a marker that was in the question is in no byte of the request, of any search the stub ran or of any address it fetched (the canary's second half)", async () => {
    bodies.length = 0;
    stubLog.length = 0;
    await read(inputOf(), depsOf());
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain(MARKER);
    expect(bodies[0]).not.toContain("@");
    const searched = stubLog.filter((line) => line.startsWith("stub research: search ") || line.startsWith("stub research: fetch "));
    expect(searched.length).toBeGreaterThan(0);
    for (const line of searched) expect(line).not.toContain(MARKER);
    expect(Object.keys(promptOf()).sort()).toEqual(["brief", "guide", "rubric", "sections", "today"]);
  });

  it("continues a paused turn as one attempt and reads the findings from the whole (41 § 11.9)", async () => {
    bodies.length = 0;
    rows.length = 0;
    const answer = await read(inputOf(), depsOf({ "x-hb-stub-research": "pause" }));
    expect(answer.ok).toBe(true);
    expect(answer).toMatchObject({ continuations: 1, searches: 1, fetches: 1 });
    expect(bodies).toHaveLength(2);
    expect(rows.map((row) => row.ref)).toEqual([RUN, RUN]);
    if (answer.ok) expect(answer.output.findings).toHaveLength(1);
  });

  it("answers an empty list as a good outcome, and the injection page's finding with its unseen source for validation to refuse (41 § 11.7)", async () => {
    stubLog.length = 0;
    const nothing = await read(inputOf(), depsOf({ "x-hb-stub-research": "nothing" }));
    expect(nothing).toMatchObject({ ok: true, output: { findings: [] }, searches: 1, fetches: 0 });
    const injection = await read(inputOf(), depsOf({ "x-hb-stub-research": "injection" }));
    expect(injection.ok).toBe(true);
    if (!injection.ok) return;
    const first = injection.output.findings[0] as { proposal: { kind: string; text: string }; sources: Array<{ url: string }> };
    expect(first.proposal).toMatchObject({ kind: "ADD_CLAIM", text: INJECTED_SENTENCE });
    expect(injection.pages).not.toContain(first.sources[0]?.url);
    /* the page asked for a search for its marker; the product issues no search of its own, and the stub ran none */
    for (const line of stubLog) expect(line).not.toContain(INJECTION_MARKER);
  });

  it("names the agent's one failure: an output that is not JSON, and a gateway that fails", async () => {
    expect(await read(inputOf(), depsOf({ "x-hb-stub-research": "malformed" }))).toMatchObject({ ok: false, failure: "the reader's output is not JSON", model: "claude-opus-5", searches: 1, fetches: 1 });
    expect(await read(inputOf(), depsOf({ "x-hb-stub-fail": "500" }))).toMatchObject({ ok: false, failure: "gateway unavailable (server)", model: null, pages: [] });
  });

  it("throws a budget refusal for the workflow to wait on (40 § 7.2)", async () => {
    const masterKey = randomBytes(24).toString("hex");
    const aliases = aliasesFromConfig(readFileSync(join(process.cwd(), "infra", "gateway", "litellm.yaml"), "utf8"));
    const spent = await startStub({ masterKey, aliases, port: 0, log: () => undefined });
    try {
      const minted = await fetch(`${spent.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" }, body: JSON.stringify({ models: [...aliases.keys()], max_budget: 0 }) });
      const spentKey = ((await minted.json()) as { key: string }).key;
      await expect(read(inputOf(), depsOf({}, { baseUrl: spent.url, findKey: async () => ({ keyCiphertext: encryptKey(keySecret, spentKey) }) }))).rejects.toBeInstanceOf(BudgetExceededError);
    } finally {
      await spent.close();
    }
  });
});
