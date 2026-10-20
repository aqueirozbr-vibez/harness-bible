import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FIXTURE_PAGES, FOUND_CLAIM, INJECTED_SENTENCE } from "@/infra/gateway/stub/research";
import { aliasesFromConfig, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import type { BudgetRowInput } from "@/lib/db/budget";
import { AppError } from "@/lib/errors";
import { callModel, type GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError, GatewayUnavailableError } from "@/lib/gateway/errors";
import { encryptKey } from "@/lib/gateway/keys";
import { requestFor } from "@/lib/gateway/policy";
import { webSearchFeeUsd } from "@/lib/gateway/prices";
import type { GatewaySpan } from "@/lib/gateway/span";
import { researchTools, type GatewayCall, type ServerTools } from "@/lib/schemas/gateway";

import { callModelTurn, CONTINUATIONS_MAX, turnCountsOf } from "./turn";

/*
 * The gateway learns research (feature-specs/41 § 3, § 11.2, § 11.9; unit 58a), against the stub: the reader's request
 * holds the two server tools with their limits and no client tool, and a request with tools of its own is refused
 * before anything is sent; the tool blocks come back and are read into the pages seen; the ledger row carries the
 * search's fee and the span its count; a paused turn is continued once with the limits lowered to what is left, as
 * one attempt with one row per request; and a stranger tool is the stub's 400, as it would be the provider's. Since
 * unit 69c (feature-specs/48 § 5.4, § 6): each block heard as the stream completes it, in order across a paused turn,
 * a listener that throws failing nothing; and a turn that fails throwing its error as it came, with what it counted.
 */

const MASTER_KEY = "test-master-key-for-the-turn";
const SECRET = "0123456789abcdef".repeat(4);
const NOW = new Date("2026-10-10T12:00:00.000Z");
const ALIASES = aliasesFromConfig(readFileSync(join(import.meta.dirname, "..", "..", "infra", "gateway", "litellm.yaml"), "utf8"));
const SECTION = `<section id="21.3" chapter="21" version="v1.0.0" edition="EN" verify="PASSED">
A loop that restarts from step 1 repeats every side effect before the failure.
figures: F-21-05 "expected work redone" 45% (derived, L14)
</section>`;
const BRIEF = "Look for the current recommended practice on idempotency keys and whether a revision changes the section's figures.";

type Fetch = typeof fetch;

function call(overrides: Partial<GatewayCall> = {}): GatewayCall & { readonly serverTools: ServerTools } {
  return { purpose: "research", alias: "hb-frontier", guide: null, principal: { organisationId: "org-research" }, traceId: "c".repeat(32), ref: "run-1", serverTools: researchTools() ?? [], ...overrides };
}

function readerRequest() {
  return { ...requestFor("researchReader"), system: [{ type: "text" as const, text: "# The researcher's reader\nRead the web for the brief.", cache_control: { type: "ephemeral" as const } }], messages: [{ role: "user" as const, content: `${SECTION}\n<brief>\n${BRIEF}\n</brief>` }] };
}

describe("a turn with the provider's web tools, against the stub", () => {
  let stub: RunningStub;
  const lines: string[] = [];
  const rows: BudgetRowInput[] = [];
  const spans: GatewaySpan[] = [];
  const bodies: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    stub = await startStub({ masterKey: MASTER_KEY, aliases: ALIASES, port: 0, log: (line) => lines.push(line), now: () => NOW });
  });
  afterAll(async () => {
    await stub.close();
  });

  async function mint(maxBudget?: number): Promise<string> {
    const res = await fetch(`${stub.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ models: [...ALIASES.keys()], ...(maxBudget === undefined ? {} : { max_budget: maxBudget }) }) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { key: string }).key;
  }

  /** A fetch that records every request body sent to the stub and adds the fixture header. */
  function recording(headers: Record<string, string> = {}): Fetch {
    return (input, init) => {
      const merged = new Headers(init?.headers);
      for (const [name, value] of Object.entries(headers)) merged.set(name, value);
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return globalThis.fetch(input, { ...init, headers: merged });
    };
  }

  function deps(key: string, headers: Record<string, string> = {}): GatewayDeps {
    return {
      baseUrl: stub.url,
      keySecret: SECRET,
      findKey: async () => ({ keyCiphertext: encryptKey(SECRET, key) }),
      append: async (row) => {
        rows.push(row);
      },
      log: (span) => spans.push(span),
      fetch: recording(headers),
      now: () => NOW,
    };
  }

  it("sends the two server tools with their limits and no client tool, reads the blocks back into the pages seen, and prices the search", async () => {
    const key = await mint();
    bodies.length = 0;
    rows.length = 0;
    spans.length = 0;
    const turn = await callModelTurn(call(), readerRequest(), deps(key));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 10 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 },
    ]);
    expect(bodies[0].tool_choice).toBeUndefined();
    expect(turn.continuations).toBe(0);
    expect(turn.unfinished).toBe(false);
    expect(turn.message.stop_reason).toBe("end_turn");
    expect(turn.searches).toBe(1);
    expect(turn.fetches).toBe(1);
    expect(turn.seen.searches[0]?.query).toBe("Look for the current recommended practice");
    expect(turn.pages).toEqual([FIXTURE_PAGES.standard.url, FIXTURE_PAGES.forum.url]);
    expect(turn.seen.texts).toHaveLength(1);
    expect(JSON.parse(turn.seen.texts[0]) as unknown).toMatchObject({ findings: [{ anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: FOUND_CLAIM }, sources: [{ url: FIXTURE_PAGES.standard.url }] }] });
    /* the row: the kind, the fee on top of the tokens, the count on the span */
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "RESEARCH", alias: "hb-frontier", outcome: "ok", ref: "run-1", principal: { organisationId: "org-research" } });
    expect(rows[0].costUsd).toBeGreaterThan(webSearchFeeUsd(1));
    expect(spans[0]["hb.web_search_requests"]).toBe(1);
    expect(spans[0]["hb.purpose"]).toBe("research");
    expect(lines.some((line) => line === 'stub research: search "Look for the current recommended practice"')).toBe(true);
    expect(lines.some((line) => line === `stub research: fetch ${FIXTURE_PAGES.standard.url}`)).toBe(true);
  });

  it("continues a paused turn once as the same attempt: the paused content goes back as the assistant's, the limits are lowered, one row per request", async () => {
    const key = await mint();
    bodies.length = 0;
    rows.length = 0;
    const turn = await callModelTurn(call({ ref: "run-pause" }), readerRequest(), deps(key, { "x-hb-stub-research": "pause" }));
    expect(bodies).toHaveLength(2);
    const second = bodies[1] as { messages: Array<{ role: string; content: unknown }>; tools: unknown };
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1].role).toBe("assistant");
    expect(JSON.stringify(second.messages[1].content)).toContain('"server_tool_use"');
    expect(second.tools).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 9 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 },
    ]);
    expect(turn.continuations).toBe(1);
    expect(turn.unfinished).toBe(false);
    expect(turn.searches).toBe(1);
    expect(turn.fetches).toBe(1);
    expect(turn.pages).toEqual([FIXTURE_PAGES.standard.url, FIXTURE_PAGES.forum.url]);
    expect(turn.content.filter((block) => block.type === "text")).toHaveLength(1);
    expect(rows.map((row) => row.ref)).toEqual(["run-pause", "run-pause"]);
    expect(lines.some((line) => line === "stub research: continued with web_search=9 web_fetch=10")).toBe(true);
  });

  it("continues without a tool whose uses are spent, and stops — unfinished — only when neither tool has a use left", async () => {
    const key = await mint();
    bodies.length = 0;
    /* one search allowed and used by the paused turn: the continuation carries the fetch tool alone, and the turn finishes */
    const turn = await callModelTurn(call({ serverTools: researchTools({ searches: 1, fetches: 10 }) ?? [] }), readerRequest(), deps(key, { "x-hb-stub-research": "pause" }));
    expect(bodies).toHaveLength(2);
    expect((bodies[1] as { tools: unknown }).tools).toEqual([{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 }]);
    expect(turn.unfinished).toBe(false);
    expect(turn.seen.texts).toHaveLength(1);
    bodies.length = 0;
    /* the search tool alone, one use, used: nothing is left to continue with — the turn ends unfinished, nothing more is sent */
    const alone = await callModelTurn(call({ serverTools: researchTools({ searches: 1, fetches: 0 }) ?? [] }), readerRequest(), deps(key, { "x-hb-stub-research": "pause" }));
    expect(bodies).toHaveLength(1);
    expect(alone.unfinished).toBe(true);
    expect(alone.seen.texts).toEqual([]);
    expect(alone.pages).toEqual([FIXTURE_PAGES.standard.url, FIXTURE_PAGES.forum.url]);
    expect(CONTINUATIONS_MAX).toBe(2);
  });

  it("refuses a request that carries tools of its own before anything is sent, and server tools of another shape", async () => {
    const key = await mint();
    bodies.length = 0;
    rows.length = 0;
    const withTools = { ...readerRequest(), tools: [{ name: "lookup", description: "a client tool", input_schema: { type: "object" as const } }] };
    await expect(callModel(call(), withTools, deps(key))).rejects.toMatchObject({ code: "GATEWAY_TOOLS_REFUSED" });
    const stranger = call({ serverTools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] as unknown as ServerTools });
    await expect(callModel(stranger, readerRequest(), deps(key))).rejects.toBeInstanceOf(AppError);
    await expect(callModel(stranger, readerRequest(), deps(key))).rejects.toMatchObject({ code: "GATEWAY_TOOLS_REFUSED" });
    expect(bodies).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it("is the stub's 400 for a tool the gateway does not know, and the injection fixture's findings cite an address no block returned", async () => {
    const key = await mint();
    const res = await fetch(`${stub.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "hb-frontier", max_tokens: 100, messages: [{ role: "user", content: "hello" }], tools: [{ name: "lookup", description: "x", input_schema: { type: "object" } }] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("not a tool this gateway knows");
    bodies.length = 0;
    const turn = await callModelTurn(call({ ref: "run-injection" }), readerRequest(), deps(key, { "x-hb-stub-research": "injection" }));
    expect(turn.pages).toEqual([FIXTURE_PAGES.injection.url, FIXTURE_PAGES.forum.url]);
    const findings = JSON.parse(turn.seen.texts[0]) as { findings: Array<{ proposal: { text: string }; sources: Array<{ url: string }> }> };
    expect(findings.findings[0].proposal.text).toBe(INJECTED_SENTENCE);
    expect(turn.pages).not.toContain(findings.findings[0].sources[0].url);
  });

  /* Unit 69c (feature-specs/48 § 6): the run's live steps are heard from the stream, not read from the answer. */
  it("tells onBlock each block as the stream completes it, every search and fetch in order, across a paused turn's requests", async () => {
    const key = await mint();
    const heard: string[] = [];
    const listen = (block: { type: string; name?: string }): void => {
      heard.push(block.type === "server_tool_use" ? `${block.type}:${String(block.name)}` : block.type);
    };
    const turn = await callModelTurn(call({ ref: "run-blocks" }), readerRequest(), deps(key), listen);
    expect(heard).toEqual(["server_tool_use:web_search", "web_search_tool_result", "server_tool_use:web_fetch", "web_fetch_tool_result", "text"]);
    expect(heard).toEqual(turn.content.map((block) => (block.type === "server_tool_use" ? `${block.type}:${block.name}` : block.type)));
    heard.length = 0;
    const paused = await callModelTurn(call({ ref: "run-blocks" }), readerRequest(), deps(key, { "x-hb-stub-research": "pause" }), listen);
    expect(paused.continuations).toBe(1);
    expect(heard).toEqual(["server_tool_use:web_search", "web_search_tool_result", "server_tool_use:web_fetch", "web_fetch_tool_result", "text"]);
  });

  /* Review of unit 70 (feature-specs/48 § 5.1): a cancelled run's reader stops reading. */
  it("sends each request of the turn with the caller's signal: fired before the turn, nothing is sent; fired mid-turn, no continuation follows; either way the turn throws with its counts", async () => {
    const key = await mint();
    bodies.length = 0;
    const before = new AbortController();
    before.abort();
    const unsent = await callModelTurn(call({ ref: "run-cancelled" }), readerRequest(), deps(key), undefined, before.signal).catch((caught: unknown) => caught);
    expect(unsent).toBeInstanceOf(Error);
    expect(bodies).toEqual([]);
    expect(turnCountsOf(unsent)).toEqual({ searches: 0, fetches: 0, continuations: 0 });
    /* a turn the provider pauses, cancelled at its first block: its first request was sent, and nothing after it */
    const midway = new AbortController();
    const stopped = await callModelTurn(call({ ref: "run-cancelled" }), readerRequest(), deps(key, { "x-hb-stub-research": "pause" }), () => midway.abort(), midway.signal).catch((caught: unknown) => caught);
    expect(stopped).toBeInstanceOf(Error);
    expect(bodies).toHaveLength(1);
    expect(turnCountsOf(stopped)).not.toBeNull();
  });

  it("goes on when a listener throws: the block is progress, never the answer", async () => {
    const key = await mint();
    const turn = await callModelTurn(call(), readerRequest(), deps(key), () => {
      throw new Error("a step could not be written");
    });
    expect(turn.unfinished).toBe(false);
    expect(turn.seen.texts).toHaveLength(1);
  });

  /* Unit 69c (feature-specs/48 § 5.4): the requests before a refused continuation were charged for their searches. */
  it("throws a continuation refused at the cap as the same BudgetExceededError, carrying the turn's counts so far", async () => {
    const thin = await mint(0.000_001);
    bodies.length = 0;
    const error = await callModelTurn(call({ ref: "run-cap" }), readerRequest(), deps(thin, { "x-hb-stub-research": "pause" })).catch((caught: unknown) => caught);
    expect(bodies).toHaveLength(2);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(turnCountsOf(error)).toEqual({ searches: 1, fetches: 0, continuations: 1 });
    /* the first request refused carries zeros; an error no turn threw carries none */
    const spent = await mint(0);
    const first = await callModelTurn(call(), readerRequest(), deps(spent)).catch((caught: unknown) => caught);
    expect(first).toBeInstanceOf(BudgetExceededError);
    expect(turnCountsOf(first)).toEqual({ searches: 0, fetches: 0, continuations: 0 });
    expect(turnCountsOf(new BudgetExceededError(NOW, "elsewhere"))).toBeNull();
    expect(turnCountsOf("not an error")).toBeNull();
  });

  it("throws a continuation the gateway could not serve as the same GatewayUnavailableError, carrying the turn's counts so far", async () => {
    const key = await mint();
    let requests = 0;
    const failSecond: GatewayDeps = {
      ...deps(key),
      fetch: (input, init) => {
        requests += 1;
        const merged = new Headers(init?.headers);
        merged.set("x-hb-stub-research", "pause");
        if (requests === 2) merged.set("x-hb-stub-fail", "500");
        return globalThis.fetch(input, { ...init, headers: merged });
      },
    };
    const error = await callModelTurn(call(), readerRequest(), failSecond).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toMatchObject({ cause: "server" });
    expect(turnCountsOf(error)).toEqual({ searches: 1, fetches: 0, continuations: 1 });
  });
});
