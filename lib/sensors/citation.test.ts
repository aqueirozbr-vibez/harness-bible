import { describe, expect, it } from "vitest";

import { NO_COVER } from "@/lib/schemas/assistant";
import { parseFigureId, parseSectionId } from "@/lib/schemas/ids";

import { citationSensor, contentTerms, quotesANumber, type SensorSection } from "./citation";

/*
 * The citation sensor (feature-specs/13 § 7.1). The behaviour worth protecting is the substitution: a claim that
 * fails keeps its place in the answer and loses its words, so the reader is told the book does not cover it rather
 * than being shown a sentence nothing supports.
 */

const SECTIONS: ReadonlyArray<SensorSection> = [
  {
    sectionId: parseSectionId("21.3"),
    text: "A retried write without an idempotency key is a second write. Durable execution replays the event log.",
    figures: [
      { figureId: parseFigureId("F-21-05"), valueText: "45%" },
      { figureId: parseFigureId("F-21-07"), valueText: "117" },
    ],
  },
  { sectionId: parseSectionId("28.1"), text: "Permissions are granted by policy, never by the agent itself.", figures: [] },
];

const claim = (text: string, sectionId = "21.3", figureId: string | null = null) => ({
  text,
  sectionId: parseSectionId(sectionId),
  figureId: figureId === null ? null : parseFigureId(figureId),
});

describe("the citation sensor (feature-specs/13 § 7.1)", () => {
  it("passes a claim that quotes its figure exactly as the release prints it", () => {
    const result = citationSensor([claim("Expected work redone is 45% at these inputs.", "21.3", "F-21-05")], SECTIONS, "en");
    expect(result.claims[0]?.substituted).toBe(false);
    expect(result.claims[0]?.valueText).toBe("45%");
    expect(result.verdict.verdict).toBe("PASS");
    expect(result.verdict.detail).toBe("1 / 1 figures found at cited location");
  });

  it("substitutes a claim that rounds or reformats the figure it cites", () => {
    /* The release prints 45%; "about 45 percent" and "0.45" are not that number as printed, and rounding is how a
       wrong figure gets past a reader who trusts the citation. */
    for (const text of ["Expected work redone is about 45 percent.", "Expected work redone is 0.45.", "Expected work redone is 44%."]) {
      const result = citationSensor([claim(text, "21.3", "F-21-05")], SECTIONS, "en");
      expect(result.claims[0]?.substituted, text).toBe(true);
      expect(result.failures[0]?.failure).toBe("figure-not-found-at-cited-location");
    }
  });

  it("reads a figure printed with a thin space as the same number", () => {
    const sections: SensorSection[] = [{ sectionId: parseSectionId("21.3"), text: "t", figures: [{ figureId: parseFigureId("F-21-09"), valueText: "1 450 rpm" }] }];
    const result = citationSensor([claim("The reference is 1 450 rpm.", "21.3", "F-21-09")], sections, "en");
    expect(result.claims[0]?.substituted).toBe(false);
  });

  it("does not read a name as a number: a lab, a section, a figure label, a script line", () => {
    for (const text of ["Lab 21 runs the chapter's executor.", "Section 21.3 states the retry policy.", "As 21.3 says, a retried write is a second write.", "Figure 3 and Table 2 show it, at derive L24."]) {
      expect(quotesANumber(text), text).toBe(false);
    }
    const result = citationSensor([claim("Lab 21 replays the event log, as 21.3 says of durable execution.")], SECTIONS, "en");
    expect(result.claims[0]?.substituted).toBe(false);
  });

  it("lets a claim quote a number the cited section prints and that is not one of its figures", () => {
    const readme = { sectionId: parseSectionId("21.4"), text: "Lab 21 kills each of 300 tasks at a random step. last run: REPRODUCED · CI · 23 Sep 2026", figures: [{ figureId: parseFigureId("F-21-06"), valueText: "77%" }] };
    const result = citationSensor(
      [
        claim("It kills each of 300 tasks at a random step and resumes them.", "21.4"),
        claim("The last run, on 23 Sep 2026 in CI, is recorded as REPRODUCED.", "21.4"),
        claim("It kills each of 500 tasks at a random step.", "21.4"),
        claim("No failure is seen in 77% of tasks.", "21.4"),
      ],
      [readme],
      "en",
    );
    expect(result.claims.map((entry) => entry.substituted)).toEqual([false, false, true, true]);
    /* A number the section does not print is the model's own; a figure's value without its id still breaks rule 3. */
    expect(result.failures.map((entry) => entry.failure)).toEqual(["number-not-in-the-cited-section", "number-without-a-figure-id"]);
  });

  it("substitutes a claim that quotes a number and cites no figure", () => {
    const result = citationSensor([claim("Roughly 117 duplicate writes a day.")], SECTIONS, "en");
    expect(result.claims[0]?.substituted).toBe(true);
    expect(result.failures[0]?.failure).toBe("number-without-a-figure-id");
  });

  it("substitutes a claim whose figure belongs to another section, and one whose section was never retrieved", () => {
    expect(citationSensor([claim("x", "28.1", "F-21-05")], SECTIONS, "en").failures[0]?.failure).toBe("figure-not-in-section");
    expect(citationSensor([claim("x", "05.2")], SECTIONS, "en").failures[0]?.failure).toBe("section-not-retrieved");
  });

  it("passes a prose claim that shares a content term with its section, and substitutes one that does not", () => {
    const shared = citationSensor([claim("Durable execution makes a retried write safe.")], SECTIONS, "en");
    expect(shared.claims[0]?.substituted).toBe(false);
    const unrelated = citationSensor([claim("Vendors publish quarterly roadmaps for procurement teams.")], SECTIONS, "en");
    expect(unrelated.claims[0]?.substituted).toBe(true);
    expect(unrelated.failures[0]?.failure).toBe("claim-does-not-appear-in-the-cited-section");
  });

  it("replaces the words and drops the citation, keeping the claim's place in the answer", () => {
    const result = citationSensor([claim("Expected work redone is 44%.", "21.3", "F-21-05"), claim("Durable execution replays the event log.")], SECTIONS, "en");
    expect(result.claims).toHaveLength(2);
    expect(result.claims[0]).toEqual({ text: NO_COVER.en, sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: false, substituted: true });
    expect(result.claims[1]?.substituted).toBe(false);
  });

  it("substitutes in the reader's language", () => {
    const result = citationSensor([claim("Vendors publish quarterly roadmaps.")], SECTIONS, "pt");
    expect(result.claims[0]?.text).toBe(NO_COVER.pt);
  });

  it("warns when some claims were replaced and fails when all of them were", () => {
    const some = citationSensor([claim("Durable execution replays the event log."), claim("Unrelated vendor roadmaps.")], SECTIONS, "en");
    expect(some.verdict.verdict).toBe("WARN");
    expect(some.verdict.detail).toContain("1 claim replaced");
    const all = citationSensor([claim("Unrelated vendor roadmaps."), claim("Another unrelated sentence entirely.")], SECTIONS, "en");
    expect(all.verdict.verdict).toBe("FAIL");
    expect(citationSensor([], SECTIONS, "en").verdict.verdict).toBe("NA");
  });

  it("agrees with the pipeline about what a number looks like", () => {
    for (const text of ["117 writes", "45%", "1.3 s", "$25", "2,000 queries"]) expect(quotesANumber(text), text).toBe(true);
    for (const text of ["no numbers here", "chapter twenty-one"]) expect(quotesANumber(text), text).toBe(false);
  });

  it("takes content terms of three letters or more that are not stop words", () => {
    const terms = contentTerms("The retried write is not a second write, and that matters.");
    expect([...terms].sort()).toEqual(["matters", "retried", "second", "write"]);
  });
});
