import { describe, expect, it } from "vitest";

import { checkBrief, sharesRun, wordsOf } from "./brief";

/*
 * The brief sensor (feature-specs/41 § 5.3, § 11.4; unit 58c): one case per check, in the order the sensor applies
 * them, and the overlap check on a brief that repeats five words of the question; and its two readings for a person's
 * research (feature-specs/48 § 5.3, § 26; unit 69b): a target among the run's sections, and no five words of any
 * earlier question the planner read.
 */

const QUESTION = "Why does a retried write without an idempotency key become a second write, and how long should the key be kept?";
const BRIEF = "Look for the current recommended practice on idempotency keys and their retention window, and whether a revision since the section's verification date changes the figures it cites. Prefer a standard or a vendor's documentation to commentary.";
/** A PEM block's first line, assembled so the repository's own secrets scan (which reads this folder) does not find it in the source. */
const PEM_LINE = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
const input = (over: Partial<Parameters<typeof checkBrief>[0]> = {}) => ({ brief: BRIEF, targets: [{ section: "21.3" }], sections: ["21.3", "21.4"], question: QUESTION, ...over });

describe("checkBrief", () => {
  it("passes a brief that describes what to look for, names a cited section, and copies nothing", () => {
    expect(checkBrief(input())).toEqual({ ok: true });
    expect(checkBrief(input({ targets: [{ section: "21.3" }, { section: "21.4" }] }))).toEqual({ ok: true });
  });

  it("refuses a secret by the product's own patterns (a PEM block's first line is one)", () => {
    expect(checkBrief(input({ brief: `${BRIEF} ${PEM_LINE} was pasted.` }))).toEqual({ ok: false, check: "SECRET" });
  });

  it("refuses an e-mail address, a URL and a long run of digits; a year, a figure and a date pass", () => {
    expect(checkBrief(input({ brief: `${BRIEF} Ask someone@example.com.` }))).toEqual({ ok: false, check: "EMAIL" });
    expect(checkBrief(input({ brief: `${BRIEF} See https://example.com/keys.` }))).toEqual({ ok: false, check: "URL" });
    expect(checkBrief(input({ brief: `${BRIEF} See www.example.com for it.` }))).toEqual({ ok: false, check: "URL" });
    expect(checkBrief(input({ brief: `${BRIEF} See example.com/keys for it.` }))).toEqual({ ok: false, check: "URL" });
    expect(checkBrief(input({ brief: `${BRIEF} Ask josé@example.com.` }))).toEqual({ ok: false, check: "EMAIL" });
    expect(checkBrief(input({ brief: `${BRIEF} Their system is intranet.acme.com.` }))).toEqual({ ok: false, check: "URL" });
    expect(checkBrief(input({ brief: `${BRIEF} Their system is acme.com.br and acme.io:8080.` }))).toEqual({ ok: false, check: "URL" });
    /* the book's own vocabulary is not an address */
    expect(checkBrief(input({ brief: `${BRIEF} The section's node.js example at v1.2 and e.g. section 21.3.` }))).toEqual({ ok: true });
    expect(checkBrief(input({ brief: `${BRIEF} Reference 12345678.` }))).toEqual({ ok: false, check: "DIGITS" });
    expect(checkBrief(input({ brief: `${BRIEF} Reference 123 456 789.` }))).toEqual({ ok: false, check: "DIGITS" });
    expect(checkBrief(input({ brief: `${BRIEF} The section was verified on 2026-03-04 and cites 24 hours and a 45% figure.` }))).toEqual({ ok: true });
  });

  it("refuses more than 200 words", () => {
    expect(checkBrief(input({ brief: Array.from({ length: 201 }, (_, i) => `word${String(i)}`).join(" ") }))).toEqual({ ok: false, check: "LENGTH" });
    expect(checkBrief(input({ brief: Array.from({ length: 200 }, (_, i) => `word${String(i)}`).join(" ") }))).toEqual({ ok: true });
  });

  it("refuses a target that is not among the run's sections, and no target at all", () => {
    expect(checkBrief(input({ targets: [{ section: "21.3" }, { section: "22.1" }] }))).toEqual({ ok: false, check: "TARGET" });
    expect(checkBrief(input({ targets: [] }))).toEqual({ ok: false, check: "TARGET" });
  });

  it("refuses a brief that repeats five consecutive words of the question, whatever the case and punctuation", () => {
    expect(checkBrief(input({ brief: `${BRIEF} The reader wonders how long should the key be kept.` }))).toEqual({ ok: false, check: "QUESTION" });
    expect(checkBrief(input({ brief: `${BRIEF} A RETRIED WRITE, WITHOUT AN IDEMPOTENCY key...` }))).toEqual({ ok: false, check: "QUESTION" });
    /* four words in a row are not the question */
    expect(checkBrief(input({ brief: `${BRIEF} Whether a retried write without a key is a second one.` }))).toEqual({ ok: true });
    /* a soft hyphen or a decomposed accent inside a word does not hide the overlap */
    expect(checkBrief(input({ brief: `${BRIEF} how long should the k\u00ADey be kept` }))).toEqual({ ok: false, check: "QUESTION" });
    expect(sharesRun("chaves de idempot\u00EAncia s\u00E3o comparadas byte", "chaves de idempote\u0302ncia sa\u0303o comparadas byte a byte")).toBe(true);
  });

  it("refuses a brief repeating five consecutive words of an earlier question the planner read (48 § 5.3)", () => {
    const earlierQuestions = ["Does the retention window for keys at Acme Payments still hold in 2026?", "And what happens to a refund retried twice?"];
    expect(checkBrief(input({ earlierQuestions }))).toEqual({ ok: true });
    expect(checkBrief(input({ earlierQuestions, brief: `${BRIEF} Also what happens to a refund retried twice.` }))).toEqual({ ok: false, check: "QUESTION" });
    expect(checkBrief(input({ earlierQuestions, brief: `${BRIEF} Check the retention window for keys at the vendor.` }))).toEqual({ ok: false, check: "QUESTION" });
    /* four words of an earlier question are not the question, and an empty list reads as a first run */
    expect(checkBrief(input({ earlierQuestions, brief: `${BRIEF} Whether a refund retried is safe.` }))).toEqual({ ok: true });
    expect(checkBrief(input({ earlierQuestions: [] }))).toEqual({ ok: true });
  });

  it("holds a target to the run's sections, which for a person's research are retrieval's and the seed's, not the cited ones alone", () => {
    const sections = ["21.3", "21.4", "22.1", "26.3"];
    expect(checkBrief(input({ sections, targets: [{ section: "22.1" }, { section: "26.3" }] }))).toEqual({ ok: true });
    expect(checkBrief(input({ sections, targets: [{ section: "22.1" }, { section: "27.1" }] }))).toEqual({ ok: false, check: "TARGET" });
  });

  it("checks in the spec's order: a secret is named before a copied question", () => {
    expect(checkBrief(input({ brief: `${PEM_LINE} ${QUESTION}` }))).toEqual({ ok: false, check: "SECRET" });
  });
});

describe("wordsOf and sharesRun", () => {
  it("lower-cases, drops punctuation and keeps letters and digits of any script", () => {
    expect(wordsOf("Chaves de idempotência: 24 horas, não 7!")).toEqual(["chaves", "de", "idempotência", "24", "horas", "não", "7"]);
  });

  it("finds a run of five shared words and not one of four", () => {
    expect(sharesRun("so how long should the key be kept, then", QUESTION)).toBe(true);
    expect(sharesRun("how long should the key", QUESTION)).toBe(true);
    expect(sharesRun("how long should the", QUESTION)).toBe(false);
    expect(sharesRun("", QUESTION)).toBe(false);
    expect(sharesRun("one two three four five six", "", 5)).toBe(false);
  });
});
