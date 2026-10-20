import { describe, expect, it } from "vitest";

import { NO_COVER, type ResolvedClaim } from "@/lib/schemas/assistant";
import { parseFigureId, parseSectionId } from "@/lib/schemas/ids";

import { BRIEF_MAX_CLAIMS, modeSensor, type ModeSensorInput } from "./mode";

/*
 * The mode sensor (feature-specs/19 § 5, § 12.2): the shape of a compare, a lab answer and a brief, checked in code
 * from the claims and the context, with the offending claim substituted as the citation sensor substitutes one.
 */

function claim(sectionId: string, text = `A claim from ${sectionId}.`, figureId: string | null = null): ResolvedClaim {
  return { text, sectionId: parseSectionId(sectionId), figureId: figureId === null ? null : parseFigureId(figureId), valueText: null, found: true, substituted: false };
}

function input(overrides: Partial<ModeSensorInput>): ModeSensorInput {
  return { mode: "explain", context: { chapter: 21 }, claims: [], modeResult: null, briefChapters: [34, 35, 36, 37, 38, 39, 40], labFigures: [], ...overrides };
}

describe("the mode sensor", () => {
  it("has nothing to keep in explain and walk: NA, every claim as it was", () => {
    const claims = [claim("21.3")];
    expect(modeSensor(input({ mode: "explain", claims }), "en")).toEqual({ claims, verdict: { sensor: "mode", verdict: "NA", detail: "n/a", data: { mode: "explain" } } });
    expect(modeSensor(input({ mode: "walk", claims }), "en").verdict.verdict).toBe("NA");
  });

  describe("compare", () => {
    const context = { chapter: 37, chapters: [37, 15] as const };

    it("passes when both chapters are cited", () => {
      const result = modeSensor(input({ mode: "compare", context, claims: [claim("37.2"), claim("15.4"), claim("37.8")] }), "en");
      expect(result.verdict).toMatchObject({ verdict: "PASS", detail: "compare · both chapters cited", data: { citedA: true, citedB: true, replaced: 0 } });
      expect(result.claims.every((entry) => !entry.substituted)).toBe(true);
    });

    it("fails when only one chapter is cited, and names it", () => {
      expect(modeSensor(input({ mode: "compare", context, claims: [claim("37.2"), claim("37.3")] }), "en").verdict).toMatchObject({ verdict: "FAIL", detail: "compare · only chapter 37 cited" });
      expect(modeSensor(input({ mode: "compare", context, claims: [claim("15.2")] }), "en").verdict.detail).toBe("compare · only chapter 15 cited");
      expect(modeSensor(input({ mode: "compare", context, claims: [] }), "en").verdict.detail).toBe("compare · neither chapter cited");
    });

    it("substitutes a claim citing a third chapter and fails", () => {
      const result = modeSensor(input({ mode: "compare", context, claims: [claim("37.2"), claim("12.1"), claim("15.4")] }), "pt");
      expect(result.verdict).toMatchObject({ verdict: "FAIL", detail: "compare · cites chapter 12, outside the pair", data: { outside: 12, replaced: 1 } });
      expect(result.claims[1]).toEqual({ text: NO_COVER.pt, sectionId: "12.1", figureId: null, valueText: null, found: false, substituted: true });
      expect(result.claims[0]?.substituted).toBe(false);
    });

    it("leaves a claim the citation sensor already replaced as it is", () => {
      const replaced: ResolvedClaim = { ...claim("12.1"), text: NO_COVER.en, found: false, substituted: true };
      const result = modeSensor(input({ mode: "compare", context, claims: [claim("37.2"), replaced, claim("15.4")] }), "en");
      expect(result.verdict.verdict).toBe("PASS");
      expect(result.claims[1]).toBe(replaced);
    });
  });

  describe("lab", () => {
    const context = { chapter: 21, labId: "lab-21" };
    const checked = [parseFigureId("F-21-05"), parseFigureId("F-21-07")];

    it("passes and counts the figures quoted from the run", () => {
      const result = modeSensor(input({ mode: "lab", context, labFigures: checked, claims: [claim("21.4"), claim("21.4", "117 duplicates a day.", "F-21-07"), claim("21.3", "0.769 survive.", "F-21-05")] }), "en");
      expect(result.verdict).toMatchObject({ verdict: "PASS", detail: "lab · 2 figures from the run", data: { fromRun: 2, checked: 2 } });
    });

    it("substitutes a figure the lab does not check, and a claim from another chapter", () => {
      const quoted = modeSensor(input({ mode: "lab", context, labFigures: checked, claims: [claim("21.4"), claim("21.3", "A figure.", "F-21-09")] }), "en");
      expect(quoted.verdict).toMatchObject({ verdict: "FAIL", detail: "lab · quotes F-21-09, not checked by Lab 21" });
      expect(quoted.claims[1]?.substituted).toBe(true);
      const elsewhere = modeSensor(input({ mode: "lab", context, labFigures: checked, claims: [claim("05.2")] }), "en");
      expect(elsewhere.verdict.detail).toBe("lab · cites 05.2, outside Lab 21's chapter");
    });

    it("applies only the chapter rule when there is no run to match figures against", () => {
      const result = modeSensor(input({ mode: "lab", context, labFigures: [], claims: [claim("21.4"), claim("21.3", "117 a day.", "F-21-07")] }), "en");
      expect(result.verdict).toMatchObject({ verdict: "PASS", detail: "lab · 2 claims in Lab 21's chapter, no run to match figures against" });
    });
  });

  describe("brief", () => {
    const context = { chapter: 37 };
    const stance = { decision: "route review to a small model first", stance: "conditional", condition: "when the escalation share stays under 30%" };

    it("passes with one to six claims in Part III and a stance", () => {
      const result = modeSensor(input({ mode: "brief", context, modeResult: stance, claims: [claim("37.8"), claim("35.2"), claim("40.1")] }), "en");
      expect(result.verdict).toMatchObject({ verdict: "PASS", detail: "brief · 3 of 3 in Part III", data: { stance: "conditional" } });
    });

    it("keeps six of seven claims and warns", () => {
      const seven = [34, 35, 36, 37, 38, 39, 40].map((chapter) => claim(`${String(chapter)}.1`));
      const result = modeSensor(input({ mode: "brief", context, modeResult: stance, claims: seven }), "en");
      expect(result.claims).toHaveLength(BRIEF_MAX_CLAIMS);
      expect(result.verdict).toMatchObject({ verdict: "WARN", detail: "brief · 7 claims, six kept", data: { dropped: 1 } });
    });

    it("substitutes a claim outside Part III, and fails without a stance or without claims", () => {
      const outside = modeSensor(input({ mode: "brief", context, modeResult: stance, claims: [claim("37.8"), claim("21.3")] }), "en");
      expect(outside.verdict).toMatchObject({ verdict: "FAIL", detail: "brief · cites 21.3, outside Part III" });
      expect(outside.claims[1]?.text).toBe(NO_COVER.en);
      expect(modeSensor(input({ mode: "brief", context, modeResult: { decision: "x", verdict: "adopt" }, claims: [claim("37.8")] }), "en").verdict.detail).toBe("brief · no stance in the mode result");
      expect(modeSensor(input({ mode: "brief", context, modeResult: stance, claims: [] }), "en").verdict.verdict).toBe("FAIL");
    });
  });
});
