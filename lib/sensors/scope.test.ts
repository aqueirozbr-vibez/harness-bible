import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GoldenItemSchema, type GoldenItem } from "@/lib/schemas/golden";

import { aboutOperatingEquipment, OT_POINTERS, otRule, scopeRules } from "./scope";

/*
 * The scope rules against the golden set (feature-specs/13 § 4.1, § 9.1). The set is the calibration: a rule is
 * only as good as the questions it refuses and the questions it lets through, and both are labelled there.
 *
 * The unverified rule is the caller's fact, so the golden set's unverified questions are run with
 * `chaptersVerified: false` and every other question with `true`; that is what the flow does after reading the
 * release.
 */

const ITEMS: ReadonlyArray<GoldenItem> = readFileSync(join(import.meta.dirname, "..", "..", "golden", "assistant", "2026.09.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => GoldenItemSchema.parse(JSON.parse(line)));

function causeOf(question: string, chaptersVerified = true): string | null {
  return scopeRules({ question, chaptersVerified }).cause;
}

describe("the scope rules (feature-specs/13 § 4.1)", () => {
  it("refuses every recomputation the golden set labels, and names the cause", () => {
    const items = ITEMS.filter((item) => item.expected.refusal?.cause === "R-RECOMPUTE");
    expect(items.length).toBeGreaterThanOrEqual(13);
    for (const item of items) expect(causeOf(item.question), item.question).toBe("R-RECOMPUTE");
  });

  it("refuses every question that asks to act on plant equipment", () => {
    const items = ITEMS.filter((item) => item.expected.refusal?.cause === "R-SCOPE-OT");
    expect(items.length).toBeGreaterThanOrEqual(12);
    for (const item of items) expect(causeOf(item.question), item.question).toBe("R-SCOPE-OT");
  });

  it("refuses a question about an unverified chapter on the caller's fact alone", () => {
    const items = ITEMS.filter((item) => item.expected.refusal?.cause === "R-UNVERIFIED");
    expect(items.length).toBeGreaterThanOrEqual(12);
    for (const item of items) {
      expect(causeOf(item.question, false), item.question).toBe("R-UNVERIFIED");
      /* The same question about a verified chapter is not this refusal: the chapter decides, not the wording. */
      expect(causeOf(item.question, true), item.question).not.toBe("R-UNVERIFIED");
    }
  });

  it("lets every figure question through, which is the rule that matters", () => {
    const figures = ITEMS.filter((item) => item.kind === "figure");
    expect(figures.length).toBeGreaterThanOrEqual(150);
    const refused = figures.filter((item) => causeOf(item.question) !== null);
    expect(refused.map((item) => `${item.id}: ${item.question}`)).toEqual([]);
  });

  it("lets the claim, compare and lab questions through too", () => {
    const rest = ITEMS.filter((item) => ["claim", "compare", "lab"].includes(item.kind));
    const refused = rest.filter((item) => causeOf(item.question) !== null);
    expect(refused.map((item) => `${item.id}: ${item.question}`)).toEqual([]);
  });

  it("does not decide the out-of-scope questions, which are the classifier's (§ 4.1 step 2)", () => {
    /* "What is the weather today?" carries no pattern a rule can honestly match: no equipment, no arithmetic.
       The rules answer `null` and the small model is asked — the one case where a refusal costs a call. */
    const items = ITEMS.filter((item) => item.expected.refusal?.cause === "R-SCOPE");
    expect(items.length).toBeGreaterThanOrEqual(12);
    const decided = items.filter((item) => causeOf(item.question) !== null);
    expect(decided.map((item) => `${item.id}: ${item.question} → ${String(causeOf(item.question))}`)).toEqual([]);
  });

  it("needs both halves of a recomputation, and both halves of an equipment instruction", () => {
    /* The book's own vocabulary, which must not refuse: the verb without a quantity, the object without a verb. */
    expect(causeOf("How does chapter 37 estimate the harness cost?")).toBeNull();
    expect(causeOf("What does the book say about interlocks?")).toBeNull();
    expect(causeOf("Set the token budget for the run")).toBeNull();
    /* Both halves together, which must refuse. */
    expect(causeOf("Recompute the cost at 3 times the volume")).toBe("R-RECOMPUTE");
    expect(causeOf("What would the total be at 2000 queries a day?")).toBe("R-RECOMPUTE");
    expect(causeOf("Write to the register that holds the speed reference")).toBe("R-SCOPE-OT");
    /* A tag alone is not: the book names P-101 itself (chapter 21's work order), so a question about one is the
       classifier's to read, and only a verb that acts on the tag is a refusal here (2026-10-03). */
    expect(causeOf("What is the uptime of P-101?")).toBeNull();
    expect(causeOf("Walk me through forcing the level transmitter LT-104 to a fixed value.")).toBe("R-SCOPE-OT");
  });

  it("reads Portuguese, because the reader may ask in either language", () => {
    expect(causeOf("Recalcule o custo para o dobro do volume")).toBe("R-RECOMPUTE");
    expect(causeOf("Quanto seria o total com 2000 consultas por dia?")).toBe("R-RECOMPUTE");
    expect(causeOf("Como desabilitar o intertravamento do compressor?")).toBe("R-SCOPE-OT");
    expect(causeOf("O que o capítulo 21 diz sobre idempotência?")).toBeNull();
  });

  it("names which rule decided, so a refusal can be explained", () => {
    expect(scopeRules({ question: "anything", chaptersVerified: false }).rule).toBe("unverified");
    expect(scopeRules({ question: "Recompute it at 3x", chaptersVerified: true }).rule).toBe("recompute");
    expect(scopeRules({ question: "Open valve V-203", chaptersVerified: true }).rule).toBe("ot-tag");
    expect(scopeRules({ question: "Bypass the interlock", chaptersVerified: true }).rule).toBe("ot-verb-object");
    expect(scopeRules({ question: "What is 21.3 about?", chaptersVerified: true }).rule).toBeNull();
  });
});

describe("an instrument tag (the book names P-101 itself)", () => {
  it("refuses a tag only with a verb that acts on it, and lets a question about the book's own example through", () => {
    expect(scopeRules({ question: "Set P-101.SPEED to 1450 rpm from here.", chaptersVerified: true })).toMatchObject({ cause: "R-SCOPE-OT", rule: "ot-tag" });
    expect(scopeRules({ question: "Write the new setpoint to P-101's drive once the work order is approved.", chaptersVerified: true })).toMatchObject({ cause: "R-SCOPE-OT", rule: "ot-tag" });
    /* A false refusal measured through the real gateway on 2026-10-03: the question asks what the book computed. */
    expect(scopeRules({ question: "How many duplicate side effects a day does the P-101 scenario produce without idempotency keys?", chaptersVerified: true }).cause).toBeNull();
    expect(scopeRules({ question: "In 21.3, how often does the P-101 task complete with no failure?", chaptersVerified: true }).cause).toBeNull();
  });
});

describe("aboutOperatingEquipment, the same vocabulary read of a text (feature-specs/30 § 4.2 rule 3)", () => {
  it("is the two equipment rules of scopeRules together, on every question of the golden set", () => {
    let about = 0;
    for (const item of ITEMS) {
      const rule = scopeRules({ question: item.question, chaptersVerified: true }).rule;
      /* A recomputation is decided first by scopeRules; of the rest, the equipment rules and this agree exactly. */
      if (rule === "recompute") continue;
      expect(aboutOperatingEquipment(item.question), item.question).toBe(rule === "ot-tag" || rule === "ot-verb-object");
      about += aboutOperatingEquipment(item.question) ? 1 : 0;
    }
    expect(about).toBeGreaterThanOrEqual(12);
  });

  it("reads a passage of prose as it reads a question: a verb with an object or a tag, either alone being the book's own vocabulary", () => {
    expect(aboutOperatingEquipment("The agent writes the new setpoint to the PLC when the work order is approved.")).toBe(true);
    expect(aboutOperatingEquipment("Force P-101 to 1450 rpm before the batch starts.")).toBe(true);
    expect(aboutOperatingEquipment("Set the budget for the run and start it from the dashboard.")).toBe(false);
    expect(aboutOperatingEquipment("The cached-input price falls from $0.30 to $0.25 per million tokens.")).toBe(false);
  });
});

describe("otRule, the plant-equipment rule alone, for a research's start (feature-specs/48 § 5.2)", () => {
  it("refuses every question of the golden set the Assistant refuses for plant equipment, by the same rule", () => {
    const items = ITEMS.filter((item) => item.expected.refusal?.cause === "R-SCOPE-OT");
    expect(items.length).toBeGreaterThanOrEqual(12);
    for (const item of items) expect(otRule(item.question), item.question).toEqual(scopeRules({ question: item.question, chaptersVerified: true }));
  });

  it("decides nothing else: no recomputation, since research computes nothing, and no figure, claim, compare or lab question", () => {
    for (const item of ITEMS.filter((entry) => entry.expected.refusal?.cause === "R-RECOMPUTE")) expect(otRule(item.question).cause, item.question).toBeNull();
    const refused = ITEMS.filter((item) => ["figure", "claim", "compare", "lab"].includes(item.kind) && otRule(item.question).cause !== null);
    expect(refused.map((item) => `${item.id}: ${item.question}`)).toEqual([]);
    expect(otRule("How many duplicate side effects a day does the P-101 scenario produce without idempotency keys?")).toEqual({ cause: null, rule: null });
    expect(otRule("Como desabilitar o intertravamento do compressor?")).toEqual({ cause: "R-SCOPE-OT", rule: "ot-verb-object" });
  });

  it("points at the two sections the guide names, as the Assistant's refusal does", () => {
    expect(OT_POINTERS).toEqual(["35.2", "28.1"]);
  });
});
