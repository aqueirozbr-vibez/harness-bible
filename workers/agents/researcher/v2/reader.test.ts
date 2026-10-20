import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FIXTURE_PAGES, INJECTION_MARKER, PAGE_NOTES, UNSEEN_PAGE } from "@/infra/gateway/stub/research";
import type { ResearchSection } from "@/lib/db/research";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { turnCountsOf } from "@/lib/gateway/turn";
import { loadGuidePart } from "@/lib/guides/load";
import { ReadPageSchema } from "@/lib/schemas/researcher";
import { RUBRIC_V1_2 } from "@/tests/fixtures/rubric";
import { startStubGateway, type StubGateway } from "@/tests/fixtures/research/stubGateway";

import { assembleReader, parseRead, read, readerRequestOf, renderTiers, type ReadInput, type ReaderDeps, type ReaderInput } from "./reader";

/*
 * The reader of a person's research (feature-specs/48 § 5.4, § 6, § 26; unit 69c) on the stub gateway, started in this
 * process: the prompt of version 1's slots on the version 2 guide, given the targets' sections only; the two server
 * tools and no client tool; the canary's second half — a marker word that was in the question is in no byte of the
 * reader's request nor of any search or fetch the stub ran, because the input has no field for it; the findings and
 * the pages' notes parsed strictly; every page the turn saw, in order, with its title, whether it was opened and the
 * search that held it; each block heard as the stream completes it; and a failure that keeps the counts of what the
 * provider charged before it.
 */

const GUIDE = loadGuidePart("researcher", "v2.0", "reader");
const RUBRIC = { version: "v1.2", appliesAt: "2026-07-01", tiers: RUBRIC_V1_2.tiers, chips: { PRIMARY: "B", VENDOR: "C", ANALYST: "D", PRACTITIONER: "E", ILLUSTRATIVE: null, DERIVED: "A", OPEN: "U" } } as const;
const TRACE = "0123456789abcdef0123456789abcdef";
const RUN = "44444444-4444-4444-8444-444444444444";
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

const promptOf = (over: Partial<ReaderInput> = {}): ReaderInput => ({ guide: GUIDE, rubric: RUBRIC, today: "2026-10-12", sections: [SECTION], brief: BRIEF, ...over });
const inputOf = (over: Partial<ReadInput> = {}): ReadInput => ({ prompt: promptOf(), call: { principal: { organisationId: "org-of-the-asker" }, traceId: TRACE, ref: RUN }, ...over });

let stub: StubGateway;
const depsOf = (headers: Record<string, string> = {}, overrides: Parameters<StubGateway["gateway"]>[1] = {}): ReaderDeps => ({ gateway: stub.gateway(headers, overrides) });

/** A block as the test reads it: its type, and the tool a `server_tool_use` names. */
const shapeOf = (block: ContentBlock): string => (block.type === "server_tool_use" ? `server_tool_use:${block.name}` : block.type);

beforeAll(async () => {
  stub = await startStubGateway();
}, 60_000);

afterAll(async () => {
  await stub.close();
});

describe("the reader's prompt and request (48 § 5.4)", () => {
  it("puts the version 2 guide part and the rubric's tiers first, cached together, then today, the targets' sections and the brief", () => {
    const prompt = assembleReader(promptOf());
    expect(prompt.system).toEqual([
      { type: "text", text: GUIDE.prefix },
      { type: "text", text: renderTiers(RUBRIC), cache_control: { type: "ephemeral" } },
    ]);
    expect(GUIDE.prefix.startsWith("# The researcher's reader — guide v2.0")).toBe(true);
    const content = prompt.messages[0].content;
    expect(content.startsWith('today: 2026-10-12\n\n<section id="21.3"')).toBe(true);
    expect(content.endsWith(`<brief>\n${BRIEF}\n</brief>`)).toBe(true);
    expect(assembleReader(promptOf({ rubric: null })).system).toEqual([{ type: "text", text: GUIDE.prefix, cache_control: { type: "ephemeral" } }]);
  });

  it("holds the two server tools with ten uses each and no client tool, and has no field for the question or who asked", () => {
    expect(Object.keys(promptOf()).sort()).toEqual(["brief", "guide", "rubric", "sections", "today"]);
    const { call, request } = readerRequestOf(inputOf());
    expect(call.serverTools).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 10 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 },
    ]);
    expect(request).not.toHaveProperty("tools");
    expect(call).toMatchObject({ purpose: "research", alias: "hb-frontier", guide: { agent: "researcher", version: "v2.0", sha256: GUIDE.sha256 }, ref: RUN });
    expect(call).not.toHaveProperty("row");
    expect(request).toMatchObject({ model: "hb-frontier", max_tokens: 16_000, output_config: { effort: "medium" } });
  });
});

describe("parseRead", () => {
  it("takes the version 2 envelope with both lists, and refuses the legacy one and a key the guide did not name, without echoing it", () => {
    expect(parseRead('{"findings":[],"notes":[]}')).toEqual({ ok: true, output: { findings: [], notes: [] } });
    expect(parseRead(`\`\`\`json\n${JSON.stringify({ findings: [], notes: [{ url: "https://a.example/", says: "It says so." }] })}\n\`\`\``)).toMatchObject({ ok: true, output: { notes: [{ url: "https://a.example/" }] } });
    expect(parseRead('{"findings":[]}')).toMatchObject({ ok: false, reason: expect.stringContaining("notes") as string });
    expect(parseRead("I found nothing.")).toEqual({ ok: false, reason: "the reader's output is not JSON" });
    const stranger = parseRead(JSON.stringify({ findings: [], notes: [], zqx_marker_key: "copied" }));
    expect(stranger).toEqual({ ok: false, reason: "the reader's output has a key the guide did not name" });
    expect(JSON.stringify(stranger)).not.toContain("zqx_marker_key");
  });
});

describe("read against the stub", () => {
  it("reads the findings and the pages' notes, the pages its tools saw, and every page in order with its title, opened, and its search", async () => {
    stub.rows.length = 0;
    const answer = await read(inputOf(), depsOf());
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.output.findings).toHaveLength(1);
    expect(answer.output.findings[0]).toMatchObject({ anchor: { kind: "SECTION", id: "21.3" }, sources: [{ url: FIXTURE_PAGES.standard.url }] });
    expect(answer.output.notes).toEqual([
      { url: FIXTURE_PAGES.standard.url, says: PAGE_NOTES.standard },
      { url: FIXTURE_PAGES.forum.url, says: PAGE_NOTES.forum },
    ]);
    expect(answer.pages).toEqual([FIXTURE_PAGES.standard.url, FIXTURE_PAGES.forum.url]);
    expect(answer.read).toEqual([
      { url: FIXTURE_PAGES.standard.url, title: FIXTURE_PAGES.standard.title, opened: true, search: 1 },
      { url: FIXTURE_PAGES.forum.url, title: FIXTURE_PAGES.forum.title, opened: false, search: 1 },
    ]);
    for (const page of answer.read) expect(ReadPageSchema.safeParse(page).success).toBe(true);
    expect(answer).toMatchObject({ searches: 1, fetches: 1, continuations: 0, model: "claude-opus-5" });
    expect(stub.rows).toHaveLength(1);
    expect(stub.rows[0]).toMatchObject({ kind: "RESEARCH", alias: "hb-frontier", outcome: "ok", ref: RUN, principal: { organisationId: "org-of-the-asker" } });
  });

  it("carries nothing of the question: a marker that was in it is in no byte of the request, nor of any search or fetch the stub ran (the canary's second half)", async () => {
    stub.bodies.length = 0;
    stub.log.length = 0;
    await read(inputOf(), depsOf());
    expect(stub.bodies).toHaveLength(1);
    expect(stub.bodies[0]).not.toContain(MARKER);
    expect(stub.bodies[0]).not.toContain("@");
    const searched = stub.log.filter((line) => line.startsWith("stub research: search ") || line.startsWith("stub research: fetch "));
    expect(searched.length).toBeGreaterThan(0);
    for (const line of searched) expect(line).not.toContain(MARKER);
  });

  it("hears each search and fetch block as the stream completes it, in order, across a paused turn's requests (48 § 6)", async () => {
    const heard: string[] = [];
    const answer = await read(inputOf({ onBlock: (block) => heard.push(shapeOf(block)) }), depsOf());
    expect(answer.ok).toBe(true);
    expect(heard).toEqual(["server_tool_use:web_search", "web_search_tool_result", "server_tool_use:web_fetch", "web_fetch_tool_result", "text"]);
    heard.length = 0;
    const paused = await read(inputOf({ onBlock: (block) => heard.push(shapeOf(block)) }), depsOf({ "x-hb-stub-research": "pause" }));
    expect(paused).toMatchObject({ ok: true, continuations: 1, searches: 1, fetches: 1 });
    expect(heard).toEqual(["server_tool_use:web_search", "web_search_tool_result", "server_tool_use:web_fetch", "web_fetch_tool_result", "text"]);
    if (paused.ok) expect(paused.output.notes).toHaveLength(2);
  });

  it("answers an empty pair for nothing found, and the injection's notes as the reader wrote them, a page no block returned among them, for the validation to drop", async () => {
    stub.log.length = 0;
    expect(await read(inputOf(), depsOf({ "x-hb-stub-research": "nothing" }))).toMatchObject({ ok: true, output: { findings: [], notes: [] }, searches: 1, fetches: 0 });
    const injection = await read(inputOf(), depsOf({ "x-hb-stub-research": "injection" }));
    expect(injection.ok).toBe(true);
    if (!injection.ok) return;
    expect(injection.output.notes).toEqual([
      { url: FIXTURE_PAGES.injection.url, says: PAGE_NOTES.injection },
      { url: UNSEEN_PAGE, says: "The page says retries are safe." },
    ]);
    expect(injection.pages).toContain(FIXTURE_PAGES.injection.url);
    expect(injection.pages).not.toContain(UNSEEN_PAGE);
    for (const line of stub.log) expect(line).not.toContain(INJECTION_MARKER);
  });

  it("names the agent's one failure: an output that is not JSON, and a gateway that fails", async () => {
    expect(await read(inputOf(), depsOf({ "x-hb-stub-research": "malformed" }))).toMatchObject({ ok: false, failure: "the reader's output is not JSON", model: "claude-opus-5", searches: 1, fetches: 1, read: [{ url: FIXTURE_PAGES.standard.url }, { url: FIXTURE_PAGES.forum.url }] });
    expect(await read(inputOf(), depsOf({ "x-hb-stub-fail": "500" }))).toMatchObject({ ok: false, failure: "gateway unavailable (server)", model: null, pages: [], read: [], searches: 0, fetches: 0 });
  });

  it("keeps what the provider charged when a continuation fails: the counts of the requests before it (48 § 5.4)", async () => {
    let requests = 0;
    const failSecond = depsOf({ "x-hb-stub-research": "pause" }, {
      fetch: async (input, init) => {
        requests += 1;
        const merged = new Headers(init?.headers);
        merged.set("x-hb-stub-research", "pause");
        if (requests === 2) merged.set("x-hb-stub-fail", "500");
        return globalThis.fetch(input, { ...init, headers: merged });
      },
    });
    expect(await read(inputOf(), failSecond)).toMatchObject({ ok: false, failure: "gateway unavailable (server)", searches: 1, fetches: 0, continuations: 1 });
  });

  it("throws a continuation's budget refusal with the turn's counts so far, for the run to end FAILED · BUDGET with them (48 § 7.2)", async () => {
    const thin = await stub.mint(0.000_001);
    const error = await read(inputOf(), depsOf({ "x-hb-stub-research": "pause" }, { key: thin })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(turnCountsOf(error)).toEqual({ searches: 1, fetches: 0, continuations: 1 });
    const spent = await stub.mint(0);
    const first = await read(inputOf(), depsOf({}, { key: spent })).catch((caught: unknown) => caught);
    expect(first).toBeInstanceOf(BudgetExceededError);
    expect(turnCountsOf(first)).toEqual({ searches: 0, fetches: 0, continuations: 0 });
  });
});
