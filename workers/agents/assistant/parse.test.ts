import { describe, expect, it } from "vitest";

import { parseFigureId, parseSectionId } from "@/lib/schemas/ids";

import { parseOutput, repairInstruction, type ParseContext } from "./parse";

/*
 * The output parser (feature-specs/13 § 6). The rule worth a test of its own: a claim citing something the prompt
 * did not carry is kept and marked, never dropped — dropping it would hide from the reader that the model said it.
 */

const CONTEXT: ParseContext = {
  sections: new Set([parseSectionId("21.3"), parseSectionId("28.1")]),
  figures: new Map([
    [parseSectionId("21.3"), new Set([parseFigureId("F-21-05")])],
    [parseSectionId("28.1"), new Set()],
  ]),
};

const CLAIM = { text: "A retried write without a key is a second write.", sectionId: "21.3", figureId: null };

function output(claims: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ claims, refusal: null, mode_result: null, ...extra });
}

describe("the assistant's output parser (feature-specs/13 § 6)", () => {
  it("parses a well-formed answer and marks every claim cited", () => {
    const result = parseOutput(output([CLAIM, { ...CLAIM, figureId: "F-21-05" }]), CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.claims.map((claim) => claim.cited)).toEqual([true, true]);
    expect(result.output.claims.every((claim) => claim.reason === null)).toBe(true);
  });

  it("keeps a claim that cites a section the prompt did not carry, and says why", () => {
    const result = parseOutput(output([{ ...CLAIM, sectionId: "05.2" }]), CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.claims).toHaveLength(1);
    expect(result.output.claims[0]?.cited).toBe(false);
    expect(result.output.claims[0]?.reason).toBe("section-not-retrieved");
    /* Kept, with its text: the citation sensor substitutes it and the ledger records that it was said. */
    expect(result.output.claims[0]?.text).toBe(CLAIM.text);
  });

  it("keeps a claim whose figure belongs to another section", () => {
    const result = parseOutput(output([{ ...CLAIM, sectionId: "28.1", figureId: "F-21-05" }]), CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.claims[0]?.cited).toBe(false);
    expect(result.output.claims[0]?.reason).toBe("figure-not-in-section");
  });

  it("reports text that is not JSON as the one failure the repair pass answers", () => {
    const result = parseOutput("Here is my answer: the book says…", CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("not-json");
    expect(repairInstruction(result.failure)).toContain("was not valid JSON");
  });

  it("reports a schema failure with the field that broke it", () => {
    const result = parseOutput(JSON.stringify({ claims: [{ text: "x" }], refusal: null, mode_result: null }), CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("schema");
    expect(result.failure.detail).toContain("sectionId");
    expect(repairInstruction(result.failure)).toContain("did not match the schema");
  });

  it("refuses an answer that carries a field the schema does not name", () => {
    const result = parseOutput(output([CLAIM], { note: "an instruction smuggled into the envelope" }), CONTEXT);
    expect(result.ok).toBe(false);
  });

  it("carries a refusal the model made, with its cause and pointers", () => {
    const text = JSON.stringify({ claims: [], refusal: { cause: "R-SCOPE", pointers: ["21.3"] }, mode_result: null });
    const result = parseOutput(text, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.refusal).toEqual({ cause: "R-SCOPE", pointers: ["21.3"] });
    expect(result.output.claims).toEqual([]);
  });

  it("never throws, whatever the model wrote", () => {
    for (const text of ["", "null", "[]", "{}", '{"claims":null}', "\u0000"]) {
      expect(() => parseOutput(text, CONTEXT)).not.toThrow();
    }
  });
});

describe("a fenced answer (measured on every real turn, 2026-10-03)", () => {
  it("parses the JSON inside a ```json fence as if the fence were not there", () => {
    const fenced = "```json\n" + output([CLAIM]) + "\n```";
    const result = parseOutput(fenced, CONTEXT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.claims[0]?.cited).toBe(true);
  });

  it("takes a bare fence and surrounding whitespace too, and leaves unfenced text alone", () => {
    expect(parseOutput("  ```\n" + output([CLAIM]) + "\n```  ", CONTEXT).ok).toBe(true);
    expect(parseOutput(output([CLAIM]), CONTEXT).ok).toBe(true);
  });

  it("still refuses what is not JSON once the fence is off, and an object cut short; a fence that never closes around a whole object is that object", () => {
    expect(parseOutput("```json\nnot json\n```", CONTEXT)).toMatchObject({ ok: false, failure: { kind: "not-json" } });
    expect(parseOutput("```json\n" + output([CLAIM]).slice(0, -8), CONTEXT)).toMatchObject({ ok: false, failure: { kind: "not-json" } });
    expect(parseOutput("```json\n" + output([CLAIM]), CONTEXT).ok).toBe(true);
  });
});

describe("the shaped modes' results (feature-specs/19 § 5)", () => {
  const RESULTS = {
    compare: { openPoint: "Whether the cache should live with the router." },
    lab: { reproduces: "The survival curve of chapter 21.", divergingMeans: null },
    brief: { decision: "route review to a small model first", stance: "conditional", condition: "while escalation stays under 30%" },
  } as const;

  it("accepts each mode's own shape and carries it", () => {
    for (const mode of ["compare", "lab", "brief"] as const) {
      const result = parseOutput(output([CLAIM], { mode_result: RESULTS[mode] }), { ...CONTEXT, mode });
      expect(result.ok, mode).toBe(true);
      if (result.ok) expect(result.output.modeResult).toEqual(RESULTS[mode]);
    }
  });

  it("refuses another mode's shape, a missing one, and a brief stance the schema does not know, naming the shape for the repair", () => {
    expect(parseOutput(output([CLAIM], { mode_result: RESULTS.lab }), { ...CONTEXT, mode: "compare" })).toMatchObject({ ok: false, failure: { kind: "schema" } });
    const missing = parseOutput(output([CLAIM]), { ...CONTEXT, mode: "brief" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(repairInstruction(missing.failure)).toContain('"stance": "recommends" | "conditional" | "leaves-open"');
    expect(parseOutput(output([CLAIM], { mode_result: { decision: "x", verdict: "adopt" } }), { ...CONTEXT, mode: "brief" }).ok).toBe(false);
  });

  it("asks nothing of mode_result in explain, or when the model refused", () => {
    expect(parseOutput(output([CLAIM], { mode_result: RESULTS.compare }), { ...CONTEXT, mode: "explain" }).ok).toBe(true);
    expect(parseOutput(JSON.stringify({ claims: [], refusal: { cause: "R-SCOPE", pointers: ["21.3"] }, mode_result: null }), { ...CONTEXT, mode: "compare" }).ok).toBe(true);
  });
});

describe("prose around the object (measured on the first real walks, 2026-10-03)", () => {
  it("discards a heading before the object and a sentence after it, fenced or not, as the guide says it will", () => {
    expect(parseOutput("**Walk of 21.8 with your inputs**\n\n" + output([CLAIM]) + "\n\nThat is the walk.", CONTEXT).ok).toBe(true);
    expect(parseOutput("Here is the answer:\n```json\n" + output([CLAIM]) + "\n```", CONTEXT).ok).toBe(true);
  });

  it("still refuses prose with no object in it, naming the parse failure", () => {
    expect(parseOutput("**Walk of 21.8** — the task survives with probability 0.769.", CONTEXT)).toMatchObject({ ok: false, failure: { kind: "not-json" } });
  });
});

describe("the walk's output (feature-specs/18 § 4)", () => {
  const WALK: ParseContext = { ...CONTEXT, walk: true };
  const STEPS = {
    steps: [
      { ordinal: 1, explained: "The inputs are the book's." },
      { ordinal: 2, explained: "A 810 against C 237.6." },
    ],
  };

  it("carries the steps when the walk's shape is there", () => {
    const result = parseOutput(output([CLAIM], { mode_result: STEPS }), WALK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.modeResult).toEqual(STEPS);
  });

  it("reports a missing or malformed mode_result as a schema failure that names the shape, so the repair asks for it", () => {
    for (const mode_result of [null, { step: 2, of: 4, explained: ["…"] }, { steps: [] }]) {
      const result = parseOutput(output([CLAIM], { mode_result }), WALK);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.failure.kind).toBe("schema");
      expect(result.failure.detail).toContain("mode_result");
      expect(repairInstruction(result.failure)).toContain('"steps"');
    }
  });

  it("asks nothing of mode_result when the model refused, or when the turn is not a walk", () => {
    expect(parseOutput(JSON.stringify({ claims: [], refusal: { cause: "R-SCOPE", pointers: ["21.3"] }, mode_result: null }), WALK).ok).toBe(true);
    expect(parseOutput(output([CLAIM]), CONTEXT).ok).toBe(true);
  });
});
