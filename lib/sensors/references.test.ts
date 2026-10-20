import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GoldenItemSchema, type GoldenItem } from "@/lib/schemas/golden";

import { namedChaptersOf, referencesOf } from "./references";

/*
 * What a question names (feature-specs/23 § 4). The golden set is the calibration, as it is for the scope rules: a
 * question generated from a section must name that section or its chapter, and a question about an unverified
 * chapter must name it with a cue word, because that is what the unverified rule reads since Assistant 2.0.
 */

const ITEMS: ReadonlyArray<GoldenItem> = readFileSync(join(import.meta.dirname, "..", "..", "golden", "assistant", "2026.09.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => GoldenItemSchema.parse(JSON.parse(line)));

describe("the references a question names (feature-specs/23 § 4)", () => {
  it("reads a section after each cue word, in EN and PT", () => {
    expect(referencesOf("What does section 21.3 say about retries?").namedSections).toEqual(["21.3"]);
    expect(referencesOf("Compare sections 21.3 with the rest").namedSections).toEqual(["21.3"]);
    expect(referencesOf("Na seção 20.3, qual é o valor?").namedSections).toEqual(["20.3"]);
    expect(referencesOf("Na secao 20.3, qual e o valor?").namedSections).toEqual(["20.3"]);
    expect(referencesOf("O que dizem as seções 09.2 e a seguinte?").namedSections).toEqual(["09.2"]);
    expect(referencesOf("Explain § 21.3").namedSections).toEqual(["21.3"]);
    expect(referencesOf("Explain §21.3").namedSections).toEqual(["21.3"]);
  });

  it("reads a chapter after each cue word, in EN and PT", () => {
    expect(referencesOf("What does chapter 34 (Selecting use cases) recommend?").namedChapters).toEqual([34]);
    expect(referencesOf("Which source does chapter 01 give?").namedChapters).toEqual([1]);
    expect(referencesOf("O que o capítulo 34 recomenda?").namedChapters).toEqual([34]);
    expect(referencesOf("O que o capitulo 34 recomenda?").namedChapters).toEqual([34]);
    expect(referencesOf("see ch34 and ch 21 and ch. 09").namedChapters).toEqual([34, 21, 9]);
    expect(referencesOf("veja o cap. 35").namedChapters).toEqual([35]);
    expect(referencesOf("What does chapter 34 say about chapter 35.").namedChapters).toEqual([34, 35]);
  });

  it("takes a list after a plural cue only", () => {
    expect(referencesOf("Compare chapters 19 and 17 on caching").namedChapters).toEqual([19, 17]);
    expect(referencesOf("Compare os capítulos 19 e 17").namedChapters).toEqual([19, 17]);
    expect(referencesOf("Does chapter 21 allow 3 and 35 retries?").namedChapters).toEqual([21]);
  });

  it("reads a lab by its number", () => {
    expect(referencesOf("What does Lab 06 reproduce?").namedLabs).toEqual([6]);
    expect(referencesOf("o que o lab 23 verifica?").namedLabs).toEqual([23]);
    expect(referencesOf("open lab-21").namedLabs).toEqual([21]);
  });

  it("keeps a section id without a cue word apart: it is read for retrieval and never refuses", () => {
    const bare = referencesOf("In 21.3, how often does the P-101 task complete with no failure?");
    expect(bare.bareSections).toEqual(["21.3"]);
    expect(bare.namedSections).toEqual([]);
    expect(namedChaptersOf(bare)).toEqual([]);

    /* A bare id that is not written as a quantity is read, and still never names a chapter. */
    const loose = referencesOf("Is 37.8 the right place to look?");
    expect(loose.bareSections).toEqual(["37.8"]);
    expect(namedChaptersOf(loose)).toEqual([]);
  });

  it("does not read a bare id written as a quantity, and reads the same id after a cue word", () => {
    for (const question of ["Is 37.8 % the right share?", "Is 37.8% right?", "Prior systems use 20.4–38.2% of memory", "It costs $37.8 a month", "Why is A 37.8× the cost?", "between 20.4-38.2 seconds"]) {
      expect(referencesOf(question).bareSections, question).toEqual([]);
    }
    expect(referencesOf("Compare sections 21.3–21.5").namedSections).toEqual(["21.3"]);
    expect(referencesOf("Does section 37.8 % say so?").namedSections).toEqual(["37.8"]);
  });

  it("names each section once, and never both named and bare", () => {
    const twice = referencesOf("Section 21.3 says one thing; does 21.3 say it again in section 21.3?");
    expect(twice.namedSections).toEqual(["21.3"]);
    expect(twice.bareSections).toEqual([]);
  });

  it("reads nothing from tags, figures, prices and budgets", () => {
    for (const question of [
      "What did the book compute for P-101?",
      "Is a kappa of 0.68 enough?",
      "Why is A 3.4× the cost of C?",
      "Write a new setpoint of 42 bar.",
      "Why does C cost $237.60 a month?",
      "Raise the cap 35 % for this month.",
      "The run took 1,021.3 seconds.",
      "What is 21.35 in the table?",
      "Does chapter 345 exist?",
      "What about section 99.3?",
      "Why 2,000 queries a day?",
    ]) {
      const found = referencesOf(question);
      expect([found.namedSections, found.namedChapters, found.namedLabs, found.bareSections], question).toEqual([[], [], [], []]);
    }
  });

  it("gathers every chapter named with a cue word, a section's and a lab's included", () => {
    expect(namedChaptersOf(referencesOf("Does section 21.3 agree with chapter 34 and Lab 23?"))).toEqual([21, 34, 23]);
  });

  describe("over the golden set", () => {
    it("every explain question that expects an answer names the section or chapter it was generated from", () => {
      const items = ITEMS.filter((item) => item.mode === "explain" && item.expected.refusal === null);
      expect(items.length).toBeGreaterThanOrEqual(201);
      const missing = items.filter((item) => {
        const found = referencesOf(item.question);
        const sections = [...found.namedSections, ...found.bareSections] as ReadonlyArray<string>;
        return !(item.context.section !== null && sections.includes(item.context.section)) && !found.namedChapters.includes(item.context.chapter);
      });
      expect(missing.map((item) => `${item.id}: ${item.question}`)).toEqual([]);
    });

    it("every unverified-chapter question names its chapter with a cue word", () => {
      const items = ITEMS.filter((item) => item.expected.refusal?.cause === "R-UNVERIFIED");
      expect(items.length).toBeGreaterThanOrEqual(12);
      for (const item of items) expect(namedChaptersOf(referencesOf(item.question)), item.question).toContain(item.context.chapter);
    });

    /* The six refusal items asked from chapters 35 and 37 name no chapter, so they reach their own rule now. One
       item does name an unverified chapter in passing, and the unverified rule comes first (23 D5): G-0275 is
       labelled R-SCOPE and refuses as R-UNVERIFIED. It is the one label Assistant 2.0 moves the wrong way. */
    it("one refusal question of another cause names a chapter, and it is an unverified one", () => {
      const items = ITEMS.filter((item) => item.expected.refusal !== null && item.expected.refusal.cause !== "R-UNVERIFIED");
      const naming = items.filter((item) => namedChaptersOf(referencesOf(item.question)).length > 0);
      expect(naming.map((item) => `${item.id}: ${item.question}`)).toEqual(["G-0275: What stock should I buy after reading chapter 37?"]);
    });
  });
});
