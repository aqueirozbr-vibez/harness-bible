import { describe, expect, it } from "vitest";

import { loadGuidePart } from "@/lib/guides/load";
import type { ResolvedClaim } from "@/lib/schemas/assistant";
import { parseFigureId, parseSectionId } from "@/lib/schemas/ids";
import type { RetrievedSection } from "@/lib/search/retrieve";
import type { PromptSection } from "@/workers/agents/assistant/assemble";

import { assembleGrader, GROUNDED_FLOOR, readGrade, repairFromGrade, scoreOf } from "./grade";

/*
 * The grounding grader (feature-specs/13 § 7.3). Two things are worth protecting: the score is ours, not the
 * model's, and the prompt cannot carry the question.
 */

const GUIDE = loadGuidePart("assistant", "v1.8", "grader");

function section(id: string): PromptSection {
  const retrieved: RetrievedSection = {
    sectionId: parseSectionId(id),
    chapter: 21,
    layer: 3,
    title: `Section ${id}`,
    version: "v1.0.0",
    verify: "PASSED",
    editionLang: "EN",
    text: "A retried write without a key is a second write.",
    figureIds: [],
    rank: { lexicalPos: 1, vectorPos: 1, rerankScore: 0.9, final: 1 },
    truncated: false,
  };
  return { section: retrieved, figures: [] };
}

const claim = (text: string, substituted = false): ResolvedClaim => ({
  text,
  sectionId: parseSectionId("21.3"),
  figureId: substituted ? null : parseFigureId("F-21-05"),
  valueText: null,
  found: !substituted,
  substituted,
});

const grade = (verdicts: ("PASS" | "FAIL")[]) =>
  JSON.stringify({ criteria: ["supported", "precise", "complete", "in_scope"].map((name, index) => ({ name, verdict: verdicts[index] ?? "PASS", reason: `${name} reason` })) });

describe("the grounding grader (feature-specs/13 § 7.3)", () => {
  it("loads its rules as a pinned part of the assistant's own version, outside the cached prefix", () => {
    expect(GUIDE.version).toBe("v1.8");
    expect(GUIDE.part).toBe("grader");
    expect(GUIDE.prefix).toContain("You grade one answer against the sections it was written from.");
    expect(() => loadGuidePart("assistant", "v1.8", "nonexistent")).toThrow(/has no part/);
  });

  it("gives the grader the sections and the claims, and has nowhere to put the question", () => {
    const prompt = assembleGrader({ guide: GUIDE, sections: [section("21.3")], claims: [claim("A retried write is a second write.")] });
    const whole = [...prompt.system.map((block) => block.text), ...prompt.messages.map((message) => message.content)].join("\n");
    expect(whole).toContain('<section id="21.3"');
    expect(whole).toContain("<claims>");
    /* The question the reader asked never reaches here: the input type has no field for it. */
    expect(whole).not.toContain("<question>");
    expect(prompt.messages).toHaveLength(2);
  });

  it("judges the claims the reader will see, substitutions included", () => {
    const prompt = assembleGrader({ guide: GUIDE, sections: [section("21.3")], claims: [claim("the book does not cover this", true)] });
    expect(prompt.messages[1]?.content).toContain("the book does not cover this");
  });

  it("computes the score from the criteria and ignores a score the model wrote", () => {
    expect(scoreOf([])).toBe(0);
    const all = readGrade(grade(["PASS", "PASS", "PASS", "PASS"]));
    expect(all.grounded).toBe(1);
    const three = readGrade(grade(["PASS", "PASS", "FAIL", "PASS"]));
    expect(three.grounded).toBe(0.75);
    /* A `grounded` field in the model's answer is accepted and ignored (invariant 12). */
    const lying = readGrade(JSON.stringify({ grounded: 0.99, criteria: [{ name: "supported", verdict: "FAIL", reason: "no" }] }));
    expect(lying.grounded).toBe(0);
  });

  it("passes at the floor and fails below it, naming the criteria that failed", () => {
    const atFloor = readGrade(grade(["PASS", "PASS", "PASS", "FAIL"]));
    expect(atFloor.grounded).toBe(0.75);
    expect(atFloor.grounded).toBeGreaterThanOrEqual(GROUNDED_FLOOR);
    expect(atFloor.verdict.verdict).toBe("PASS");
    expect(atFloor.verdict.detail).toContain("in_scope");

    const below = readGrade(grade(["FAIL", "FAIL", "PASS", "PASS"]));
    expect(below.grounded).toBe(0.5);
    expect(below.verdict.verdict).toBe("FAIL");
    expect(below.verdict.detail).toBe("grounded 0.50 · isolated context · supported, precise");
    /* The names as data, for a reader that must not parse a sentence (the gate's per-criterion κ, feature-specs/22 § 5). */
    expect(below.verdict.data).toEqual({ grounded: 0.5, criteria: 4, failed: 2, failedCriteria: "supported,precise" });
    expect(readGrade(grade(["PASS", "PASS", "PASS", "PASS"])).verdict.data).toMatchObject({ failed: 0, failedCriteria: "" });
  });

  it("is not applicable when the grader's answer cannot be read, and never throws", () => {
    for (const text of ["", "not json", "{}", '{"criteria":[]}', '{"criteria":[{"name":"unknown","verdict":"PASS","reason":"x"}]}']) {
      const graded = readGrade(text);
      expect(graded.verdict.verdict, text).toBe("NA");
      expect(graded.grounded, text).toBeNull();
    }
  });

  it("turns the failed criteria into the repair pass's instruction", () => {
    const instruction = repairFromGrade(readGrade(grade(["FAIL", "PASS", "FAIL", "PASS"])));
    expect(instruction).toContain("supported: supported reason");
    expect(instruction).toContain("complete: complete reason");
    expect(instruction).not.toContain("precise:");
  });
});

describe("a fenced grade (measured 2026-10-03: the real grader fences its object too)", () => {
  it("reads the criteria inside a ```json fence and scores them as before", () => {
    const fenced = "```json\n" + JSON.stringify({ criteria: [{ name: "supported", verdict: "PASS", reason: "yes" }, { name: "precise", verdict: "PASS", reason: "yes" }] }) + "\n```";
    const graded = readGrade(fenced);
    expect(graded.grounded).toBe(1);
    expect(graded.verdict.verdict).toBe("PASS");
  });
});
