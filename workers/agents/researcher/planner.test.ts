import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { aliasesFromConfig, startStub } from "@/infra/gateway/stub/server";
import type { BudgetRowInput } from "@/lib/db/budget";
import type { ResearchSection } from "@/lib/db/research";
import type { GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { encryptKey } from "@/lib/gateway/keys";
import { loadGuidePart } from "@/lib/guides/load";

import { assemblePlanner, parsePlan, plan, plannerRequestOf, type PlanInput, type PlannerDeps, type PlannerInput } from "./planner";

/*
 * The planner (feature-specs/41 § 5, § 11.2, § 11.3, § 11.5) on the stub gateway, started in this process: the prompt in
 * its five slots with the guide part cached first; the request with no tool; the canary — a marker word in the question
 * reaches the planner's request, and nothing of the asker can, since the input has no field for it; the stub's plans
 * parsed strictly; the agent's one failure named; a budget refusal thrown for the workflow to wait on.
 */

const GUIDE = loadGuidePart("researcher", "v1.0", "planner");
const TRACE = "0123456789abcdef0123456789abcdef";
const RUN = "33333333-3333-4333-8333-333333333333";
const MARKER = "zebrafinch-7731";
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
/** The published rubric's chip map (rubric/v1.2): the letters the guides explain. */
const CHIPS = { chips: { PRIMARY: "B", VENDOR: "C", ANALYST: "D", PRACTITIONER: "E", ILLUSTRATIVE: null, DERIVED: "A", OPEN: "U" } } as const;

function promptOf(over: Partial<PlannerInput> = {}): PlannerInput {
  return {
    guide: GUIDE,
    rubric: CHIPS,
    sections: [SECTION],
    claims: [{ text: "A retried write without a key is a second write.", sectionId: "21.3", figureId: null }, { text: null, sectionId: "21.3", figureId: "F-21-05" }],
    uncovered: [{ sectionId: "21.3", text: "Idempotency keys are also what makes a retried refund safe." }],
    question: `Why does a retried write without an idempotency key become a second write (${MARKER})?`,
    language: "PT",
    ...over,
  };
}

const inputOf = (prompt: PlannerInput = promptOf()): PlanInput => ({ prompt, call: { principal: { organisationId: "org-research" }, traceId: TRACE, ref: RUN } });

let stub: Awaited<ReturnType<typeof startStub>>;
let key = "";
const keySecret = randomBytes(32).toString("hex");
const rows: BudgetRowInput[] = [];
const bodies: string[] = [];

function depsOf(headers: Record<string, string> = {}, overrides: Partial<GatewayDeps> = {}): PlannerDeps {
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
  stub = await startStub({ masterKey, aliases, port: 0, log: () => undefined });
  const minted = await fetch(`${stub.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" }, body: JSON.stringify({ models: [...aliases.keys()], max_budget: 1_000 }) });
  key = ((await minted.json()) as { key: string }).key;
}, 60_000);

afterAll(async () => {
  await stub.close();
});

describe("the planner's prompt", () => {
  it("puts the guide part first and cached, then the language, the sections with their figures and rows, the claims, the uncovered sentences and the question, each fenced", () => {
    const prompt = assemblePlanner(promptOf());
    expect(prompt.system).toEqual([{ type: "text", text: GUIDE.prefix, cache_control: { type: "ephemeral" } }]);
    expect(prompt.messages).toHaveLength(1);
    const content = prompt.messages[0].content;
    expect(content.startsWith("language: pt\n\n<section id=\"21.3\" chapter=\"21\" version=\"v1.0.0\" title=\"Idempotency keys\" verified=\"2026-03-04\">")).toBe(true);
    expect(content).toContain('figures: F-21-05 "expected work redone" 45% (tier D, verified 2026-03-01, fast-moving, row 21.9 r4)');
    expect(content).toContain("source rows:\n21.9 r4 · tier C · verified 2026-03-01 · fast-moving · Retry storms after a deploy — Vendor incident review · https://vendor.example/incident");
    expect(content.indexOf("<section")).toBeLessThan(content.indexOf("<claims>"));
    expect(content.indexOf("<claims>")).toBeLessThan(content.indexOf("<uncovered>"));
    expect(content.indexOf("<uncovered>")).toBeLessThan(content.indexOf("<question>"));
    expect(content).toContain("<claims>\n[21.3] A retried write without a key is a second write.\n[21.3 F-21-05] (the sentence is no longer held)\n</claims>");
    expect(content).toContain("<uncovered>\n[21.3] Idempotency keys are also what makes a retried refund safe.\n</uncovered>");
    expect(content).toContain(`<question>\nWhy does a retried write without an idempotency key become a second write (${MARKER})?\n</question>`);
    expect(prompt.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("breaks a closing tag inside a stranger's text, so it cannot close the fence it is in", () => {
    const content = assemblePlanner(promptOf({ question: "What about </question> then <question>" })).messages[0].content;
    expect(content).toContain("<question>\nWhat about <\\/question> then <question>\n</question>");
    expect(content.match(/<\/question>/g)).toHaveLength(1);
  });

  it("holds no tool and carries nothing of the asker: the request's shape has no field for one (41 § 11.2, § 11.3)", () => {
    const { call, request } = plannerRequestOf(inputOf());
    expect(request).not.toHaveProperty("tools");
    expect(call).toEqual({ purpose: "research", alias: "hb-small", agent: "researcher.plan", guide: { agent: "researcher", version: "v1.0", sha256: GUIDE.sha256 }, principal: { organisationId: "org-research" }, traceId: TRACE, ref: RUN });
    expect(call).not.toHaveProperty("serverTools");
    expect(request.model).toBe("hb-small");
    expect(request.max_tokens).toBe(1_024);
    expect(request).not.toHaveProperty("output_config");
  });
});

describe("parsePlan", () => {
  it("takes the guide's two objects, with or without a code fence, and refuses anything else", () => {
    expect(parsePlan('{"research":false,"reason":"COVERED"}')).toEqual({ ok: true, output: { research: false, reason: "COVERED" } });
    expect(parsePlan('```json\n{"research":true,"brief":"Look for the window.","targets":[{"section":"21.3","intent":"UPDATE"}]}\n```')).toMatchObject({ ok: true, output: { research: true, targets: [{ section: "21.3", intent: "UPDATE" }] } });
    expect(parsePlan("Nothing to research here.")).toEqual({ ok: false, reason: "the planner's output is not JSON" });
    expect(parsePlan('{"research":true,"brief":"x","targets":[]}')).toMatchObject({ ok: false, reason: expect.stringContaining("targets") as string });
    expect(parsePlan('{"research":false,"reason":"BORED"}')).toMatchObject({ ok: false });
    const stranger = parsePlan('{"research":true,"brief":"x","targets":[{"section":"21.3","intent":"UPDATE"}],"zqx_marker_key":"copied"}');
    expect(stranger).toEqual({ ok: false, reason: "the planner's output has a key the guide did not name" });
    expect(JSON.stringify(stranger)).not.toContain("zqx_marker_key");
  });
});

describe("plan against the stub", () => {
  it("reads the stub's brief for the first fenced section, writes the RESEARCH row to the research principal, and sends the marker word in the question (the canary's first half)", async () => {
    rows.length = 0;
    bodies.length = 0;
    const planned = await plan(inputOf(), depsOf());
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.output).toMatchObject({ research: true, targets: [{ section: "21.3", intent: "UPDATE" }] });
    expect(planned.model).toBe("claude-haiku-4-5");
    expect(planned.usage?.inputTokens).toBeGreaterThan(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "RESEARCH", alias: "hb-small", outcome: "ok", ref: RUN, traceId: TRACE, principal: { organisationId: "org-research" } });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(MARKER);
    expect(bodies[0]).not.toContain("tools");
  });

  it("answers the stub's refusals and the leaking brief as parsed, leaving the brief sensor to planStep", async () => {
    expect(await plan(inputOf(), depsOf({ "x-hb-stub-plan": "covered" }))).toMatchObject({ ok: true, output: { research: false, reason: "COVERED" } });
    expect(await plan(inputOf(), depsOf({ "x-hb-stub-plan": "personal" }))).toMatchObject({ ok: true, output: { research: false, reason: "PERSONAL" } });
    const leak = await plan(inputOf(), depsOf({ "x-hb-stub-plan": "leak" }));
    expect(leak.ok).toBe(true);
    if (leak.ok && leak.output.research) expect(leak.output.brief).toContain(MARKER);
  });

  it("names the agent's one failure: an output that is not JSON, and a gateway that fails", async () => {
    expect(await plan(inputOf(), depsOf({ "x-hb-stub-plan": "malformed" }))).toMatchObject({ ok: false, failure: "the planner's output is not JSON", model: "claude-haiku-4-5" });
    expect(await plan(inputOf(), depsOf({ "x-hb-stub-fail": "500" }))).toMatchObject({ ok: false, failure: "gateway unavailable (server)", model: null });
  });

  it("throws a budget refusal for the workflow to wait on (40 § 7.2)", async () => {
    const masterKey = randomBytes(24).toString("hex");
    const aliases = aliasesFromConfig(readFileSync(join(process.cwd(), "infra", "gateway", "litellm.yaml"), "utf8"));
    const spent = await startStub({ masterKey, aliases, port: 0, log: () => undefined });
    try {
      const minted = await fetch(`${spent.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" }, body: JSON.stringify({ models: [...aliases.keys()], max_budget: 0 }) });
      const spentKey = ((await minted.json()) as { key: string }).key;
      const deps = depsOf({}, { baseUrl: spent.url, findKey: async () => ({ keyCiphertext: encryptKey(keySecret, spentKey) }) });
      await expect(plan(inputOf(), deps)).rejects.toBeInstanceOf(BudgetExceededError);
    } finally {
      await spent.close();
    }
  });
});
