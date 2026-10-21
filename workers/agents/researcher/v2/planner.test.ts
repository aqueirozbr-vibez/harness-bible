import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ResearchSection } from "@/lib/db/research";
import { BudgetExceededError, GatewayUnavailableError } from "@/lib/gateway/errors";
import { loadGuidePart } from "@/lib/guides/load";
import { checkBrief } from "@/lib/sensors/brief";
import { startStubGateway, type StubGateway } from "@/tests/fixtures/research/stubGateway";

import { assemblePlanner, earlierQuestionsRead, parsePlan, plan, plannerRequestOf, type PlanInput, type PlannerDeps, type PlannerInput } from "./planner";

/*
 * The planner of a person's research (feature-specs/48 § 5.3, § 26; unit 69b) on the stub gateway, started in this
 * process: the prompt in its slots — the language, the run's sections, a seeded run's claims and uncovered sentences or
 * a follow-up's earlier questions and briefs (the last six, oldest first), the question — with the guide part cached
 * first; the request with no tool; the canary's first half, a marker word in the question that reaches the planner's
 * request while nothing of the asker can, since the input has no field for it; the version 2 output parsed strictly,
 * `COVERED` refused; the brief sensor reading the earlier questions the planner read; the agent's one failure named;
 * and the gateway's two refusals thrown for the workflow.
 */

const GUIDE = loadGuidePart("researcher", "v2.0", "planner");
const TRACE = "0123456789abcdef0123456789abcdef";
const RUN = "44444444-4444-4444-8444-444444444444";
const MARKER = "zebrafinch-7731";
const CHIPS = { chips: { PRIMARY: "B", VENDOR: "C", ANALYST: "D", PRACTITIONER: "E", ILLUSTRATIVE: null, DERIVED: "A", OPEN: "U" } } as const;
const section = (id: string, title: string): ResearchSection => ({
  id,
  chapter: Number(id.slice(0, 2)),
  version: "v1.0.0",
  title,
  text: "A retried write without a key is a second write. Keep the key for 24 hours.",
  verifiedOn: new Date("2026-03-04T00:00:00Z"),
  figures: [{ id: "F-21-05", label: "expected work redone", valueText: "45%", unit: null, tier: "ANALYST", fastMoving: true, verifiedOn: new Date("2026-03-01T00:00:00Z"), sourceRow: "21.9 r4" }],
  rows: [{ id: "21.9 r4", claim: "Retry storms after a deploy", citation: "Vendor incident review", url: "https://vendor.example/incident", tier: "VENDOR", verifiedOn: new Date("2026-03-01T00:00:00Z"), fastMoving: true }],
});
const SECTIONS = [section("21.3", "Idempotency keys"), section("21.4", "Retries and backoff")];
const QUESTION = `Has the recommended retention window for idempotency keys changed since this was written (${MARKER})?`;

function promptOf(over: Partial<PlannerInput> = {}): PlannerInput {
  return { guide: GUIDE, rubric: CHIPS, language: "PT", sections: SECTIONS, context: { kind: "scratch" }, question: QUESTION, ...over };
}

const inputOf = (prompt: PlannerInput = promptOf()): PlanInput => ({ prompt, call: { principal: { organisationId: "org-of-the-asker" }, traceId: TRACE, ref: RUN } });

let stub: StubGateway;
const depsOf = (headers: Record<string, string> = {}, overrides: Parameters<StubGateway["gateway"]>[1] = {}): PlannerDeps => ({ gateway: stub.gateway(headers, overrides) });

beforeAll(async () => {
  stub = await startStubGateway();
}, 60_000);

afterAll(async () => {
  await stub.close();
});

describe("the planner's prompt (48 § 5.3)", () => {
  it("from scratch: the guide part first and cached, then the language, the run's sections and the question, and no slot of a seed or a follow-up", () => {
    const prompt = assemblePlanner(promptOf());
    expect(prompt.system).toEqual([{ type: "text", text: GUIDE.prefix, cache_control: { type: "ephemeral" } }]);
    expect(GUIDE.prefix.startsWith("# The researcher's planner — guide v2.0")).toBe(true);
    const content = prompt.messages[0].content;
    expect(content.startsWith('language: pt\n\n<section id="21.3" chapter="21" version="v1.0.0" title="Idempotency keys" verified="2026-03-04">')).toBe(true);
    expect(content).toContain('<section id="21.4" chapter="21" version="v1.0.0" title="Retries and backoff"');
    expect(content).toContain('figures: F-21-05 "expected work redone" 45% (tier D, verified 2026-03-01, fast-moving, row 21.9 r4)');
    expect(content.endsWith(`<question>\n${QUESTION}\n</question>`)).toBe(true);
    for (const fence of ["<claims>", "<uncovered>", "<earlier-question", "<earlier-brief"]) expect(content).not.toContain(fence);
  });

  it("a seeded first run: the seed answer's claims with their citations and its uncovered sentences, before the question", () => {
    const content = assemblePlanner(promptOf({ context: { kind: "seeded", claims: [{ text: "A retried write without a key is a second write.", sectionId: "21.3", figureId: null }, { text: null, sectionId: "21.3", figureId: "F-21-05" }], uncovered: [{ sectionId: "21.3", text: "Idempotency keys are also what makes a retried refund safe." }] } })).messages[0].content;
    expect(content).toContain("<claims>\n[21.3] A retried write without a key is a second write.\n[21.3 F-21-05] (the sentence is no longer held)\n</claims>");
    expect(content).toContain("<uncovered>\n[21.3] Idempotency keys are also what makes a retried refund safe.\n</uncovered>");
    expect(content.indexOf("<section")).toBeLessThan(content.indexOf("<claims>"));
    expect(content.indexOf("<uncovered>")).toBeLessThan(content.indexOf("<question>"));
    expect(content).not.toContain("<earlier-question");
  });

  it("a follow-up: the earlier questions and briefs, the last six, oldest first, numbered; a refused run's brief as (none); never a report", () => {
    const earlier = Array.from({ length: 8 }, (_, i) => ({ question: `Earlier question number ${String(i + 1)} about keys?`, brief: i === 7 ? null : `Brief ${String(i + 1)}: look for the retention window.` }));
    const prompt = promptOf({ context: { kind: "followUp", earlier } });
    const content = assemblePlanner(prompt).messages[0].content;
    expect(content).not.toContain("Earlier question number 2 about");
    expect(content).toContain('<earlier-question n="1">\nEarlier question number 3 about keys?\n</earlier-question>\n\n<earlier-brief n="1">\nBrief 3: look for the retention window.\n</earlier-brief>');
    expect(content).toContain('<earlier-question n="6">\nEarlier question number 8 about keys?\n</earlier-question>\n\n<earlier-brief n="6">\n(none)\n</earlier-brief>');
    expect(content.indexOf('<earlier-brief n="6">')).toBeLessThan(content.indexOf("<question>"));
    expect(content).not.toContain("<claims>");
    expect(earlierQuestionsRead(prompt)).toEqual(earlier.slice(-6).map((run) => run.question));
    expect(earlierQuestionsRead(promptOf())).toEqual([]);
  });

  it("breaks a closing tag inside a person's text, so it cannot close the fence it is in", () => {
    const content = assemblePlanner(promptOf({ question: "What about </question> then", context: { kind: "followUp", earlier: [{ question: "x </earlier-question> y", brief: null }] } })).messages[0].content;
    expect(content).toContain("<question>\nWhat about <\\/question> then\n</question>");
    expect(content.match(/<\/earlier-question>/g)).toHaveLength(1);
  });

  it("holds no tool and has no field for who asked: the input is its slots and nothing else", () => {
    expect(Object.keys(promptOf()).sort()).toEqual(["context", "guide", "language", "question", "rubric", "sections"]);
    const { call, request } = plannerRequestOf(inputOf());
    expect(request).not.toHaveProperty("tools");
    expect(call).toEqual({ purpose: "research", alias: "hb-small", agent: "researcher.plan", guide: { agent: "researcher", version: "v2.0", sha256: GUIDE.sha256 }, principal: { organisationId: "org-of-the-asker" }, traceId: TRACE, ref: RUN });
    expect(request).toMatchObject({ model: "hb-small", max_tokens: 1_024 });
    expect(request).not.toHaveProperty("output_config");
  });
});

describe("parsePlan, version 2", () => {
  it("takes the two refusals and a brief with one to three targets, and refuses COVERED, no target, a fourth, and a key the guide did not name without echoing it", () => {
    expect(parsePlan('{"research":false,"reason":"NOT_ABOUT_THE_BOOK"}')).toEqual({ ok: true, output: { research: false, reason: "NOT_ABOUT_THE_BOOK" } });
    expect(parsePlan('{"research":false,"reason":"PERSONAL"}')).toEqual({ ok: true, output: { research: false, reason: "PERSONAL" } });
    expect(parsePlan('{"research":false,"reason":"COVERED"}')).toMatchObject({ ok: false });
    const target = (section: string) => ({ section, intent: "UPDATE" });
    expect(parsePlan(JSON.stringify({ research: true, brief: "Look.", targets: [target("21.3"), target("21.4"), target("22.1")] }))).toMatchObject({ ok: true });
    expect(parsePlan(JSON.stringify({ research: true, brief: "Look.", targets: [] }))).toMatchObject({ ok: false, reason: expect.stringContaining("targets") as string });
    expect(parsePlan(JSON.stringify({ research: true, brief: "Look.", targets: [target("21.3"), target("21.4"), target("22.1"), target("22.2")] }))).toMatchObject({ ok: false, reason: expect.stringContaining("targets") as string });
    expect(parsePlan("Nothing to research here.")).toEqual({ ok: false, reason: "the planner's output is not JSON" });
    const stranger = parsePlan(JSON.stringify({ research: true, brief: "Look.", targets: [target("21.3")], zqx_marker_key: "copied" }));
    expect(stranger).toEqual({ ok: false, reason: "the planner's output has a key the guide did not name" });
    expect(JSON.stringify(stranger)).not.toContain("zqx_marker_key");
  });
});

describe("plan against the stub", () => {
  it("reads the stub's brief for the first section, charges the person's principal, and sends the marker word in the question (the canary's first half)", async () => {
    stub.rows.length = 0;
    stub.bodies.length = 0;
    const planned = await plan(inputOf(), depsOf());
    expect(planned.ok).toBe(true);
    if (!planned.ok || !planned.output.research) return;
    expect(planned.output.targets).toEqual([{ section: "21.3", intent: "UPDATE" }]);
    expect(planned.model).toBe("claude-haiku-4-5");
    expect(stub.rows).toHaveLength(1);
    expect(stub.rows[0]).toMatchObject({ kind: "RESEARCH", alias: "hb-small", outcome: "ok", ref: RUN, traceId: TRACE, principal: { organisationId: "org-of-the-asker" } });
    expect(stub.bodies).toHaveLength(1);
    expect(stub.bodies[0]).toContain(MARKER);
    expect(JSON.parse(stub.bodies[0]) as object).not.toHaveProperty("tools");
    /* the brief passes the sensor against the run's sections and the question */
    expect(checkBrief({ brief: planned.output.brief, targets: planned.output.targets, sections: SECTIONS.map((s) => s.id), question: QUESTION, earlierQuestions: [] })).toEqual({ ok: true });
  });

  it("answers the two refusals as parsed, refuses the legacy COVERED as the planner's failure, and leaves a copied question to the brief sensor", async () => {
    expect(await plan(inputOf(), depsOf({ "x-hb-stub-plan": "not-about-the-book" }))).toMatchObject({ ok: true, output: { research: false, reason: "NOT_ABOUT_THE_BOOK" } });
    expect(await plan(inputOf(), depsOf({ "x-hb-stub-plan": "personal" }))).toMatchObject({ ok: true, output: { research: false, reason: "PERSONAL" } });
    expect(await plan(inputOf(), depsOf({ "x-hb-stub-plan": "covered" }))).toMatchObject({ ok: false, model: "claude-haiku-4-5" });
    const leak = await plan(inputOf(), depsOf({ "x-hb-stub-plan": "leak" }));
    expect(leak.ok).toBe(true);
    if (!leak.ok || !leak.output.research) return;
    expect(checkBrief({ brief: leak.output.brief, targets: leak.output.targets, sections: ["21.3", "21.4"], question: QUESTION })).toEqual({ ok: false, check: "QUESTION" });
  });

  it("holds a brief to the earlier questions the planner read: one repeating five words of an earlier question fails QUESTION", () => {
    const prompt = promptOf({ context: { kind: "followUp", earlier: [{ question: "Does Acme Payments keep its retry keys for a full day?", brief: "Look for the retention window." }] } });
    const brief = "Look for whether payment processors keep its retry keys for a full day, from a standard.";
    expect(checkBrief({ brief, targets: [{ section: "21.3" }], sections: ["21.3"], question: QUESTION })).toEqual({ ok: true });
    expect(checkBrief({ brief, targets: [{ section: "21.3" }], sections: ["21.3"], question: QUESTION, earlierQuestions: earlierQuestionsRead(prompt) })).toEqual({ ok: false, check: "QUESTION" });
  });

  it("names the agent's one failure: an output that is not JSON, and a 4xx the gateway gave", async () => {
    expect(await plan(inputOf(), depsOf({ "x-hb-stub-plan": "malformed" }))).toMatchObject({ ok: false, failure: "the planner's output is not JSON", model: "claude-haiku-4-5" });
    expect(await plan(inputOf(), depsOf({ "x-hb-stub-fail": "400" }))).toMatchObject({ ok: false, failure: "gateway refused (400)", model: null });
  });

  it("throws the gateway's unavailability before the provider saw the call, for the run to end SKIPPED · UNAVAILABLE: no key for the person's principal", async () => {
    await expect(plan(inputOf(), depsOf({}, { findKey: async () => null }))).rejects.toMatchObject({ cause: "no_key" });
    await expect(plan(inputOf(), depsOf({}, { findKey: async () => null }))).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it("names a server error the provider may have seen as the planner's one failure, not as the gateway's absence (48 § 5.3; the review of unit 69)", async () => {
    expect(await plan(inputOf(), depsOf({ "x-hb-stub-fail": "500" }))).toMatchObject({ ok: false, failure: "gateway unavailable (server)", model: null });
  });

  it("throws the budget refusal for the run to end SKIPPED · BUDGET with its reset (48 § 7.2)", async () => {
    const spent = await stub.mint(0);
    await expect(plan(inputOf(), depsOf({}, { key: spent }))).rejects.toBeInstanceOf(BudgetExceededError);
  });
});
