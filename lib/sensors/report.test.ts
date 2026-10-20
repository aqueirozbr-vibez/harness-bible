import { describe, expect, it } from "vitest";

import { OT_PARAGRAPH } from "@/infra/gateway/stub/research";
import { REPORT_DROP_RULES, ReportParagraphSchema, ReportSchema, type ReportParagraph } from "@/lib/schemas/researcher";

import { checkReport, pagesCitedBy } from "./report";

/*
 * The report sensor (feature-specs/48 § 5.7, § 26; unit 69d): a good report passes whole with nothing counted; then one
 * case per rule, in the order the sensor applies them — a section the run did not hold, a page with no note, no
 * reference, an address, a secret, an instruction to act on plant equipment, words past the 600th — each dropping its
 * paragraph alone and counting it by rule; and a report left with nothing fails.
 */

/** A PEM block's first line, assembled so the repository's own secrets scan (which reads this folder) does not find it in the source. */
const PEM_LINE = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");

const para = (text: string, sections: ReadonlyArray<string>, pages: ReadonlyArray<number>): ReportParagraph => ReportParagraphSchema.parse({ text, sections, pages });
const words = (count: number, cite = "[1]"): string => `${Array.from({ length: count - 1 }, (_, i) => `word${String(i)}`).join(" ")} ${cite}`;

const GOOD = [
  para("The pages read describe the 2026 revision of the practice [1], which keeps a key for at least 24 hours.", ["21.3"], [1]),
  para("A forum thread [3] reports the same from experience, with less authority.", [], [3]),
  para("Nothing in the pages contradicts the rest of section 21.3.", ["21.3"], []),
];
const input = (paragraphs: ReadonlyArray<ReportParagraph>) => ({ paragraphs, sections: ["21.3", "21.4"], pages: [1, 3] });

describe("checkReport", () => {
  it("passes a report whose every paragraph cites a held section or a page with a note, and counts nothing", () => {
    const verdict = checkReport(input(GOOD));
    expect(verdict).toEqual({ ok: true, report: { paragraphs: GOOD, dropped: {} } });
    if (verdict.ok) expect(ReportSchema.safeParse(verdict.report).success).toBe(true);
  });

  it("drops a paragraph citing a section the run did not hold (SECTION)", () => {
    expect(checkReport(input([...GOOD, para("Section 27.1 says otherwise [1].", ["27.1"], [1])]))).toEqual({ ok: true, report: { paragraphs: GOOD, dropped: { SECTION: 1 } } });
  });

  it("drops a paragraph citing a page with no note, in its pages or as an [n] in its text (PAGE)", () => {
    expect(checkReport(input([...GOOD, para("A further page agrees [2].", [], [2])]))).toEqual({ ok: true, report: { paragraphs: GOOD, dropped: { PAGE: 1 } } });
    expect(checkReport(input([...GOOD, para("A further page agrees [9].", ["21.3"], [])]))).toEqual({ ok: true, report: { paragraphs: GOOD, dropped: { PAGE: 1 } } });
    expect(pagesCitedBy({ text: "As [1] and [3] say, and [1] again.", pages: [3, 4] })).toEqual([3, 4, 1]);
  });

  it("drops a paragraph that cites nothing (NO_REFERENCE)", () => {
    expect(checkReport(input([...GOOD, para("In short, the book is right.", [], [])]))).toEqual({ ok: true, report: { paragraphs: GOOD, dropped: { NO_REFERENCE: 1 } } });
  });

  it("drops a paragraph whose text holds an address, by the brief sensor's own patterns (ADDRESS)", () => {
    const address = [
      para("The full text is at https://standards.example/idempotency-keys [1].", [], [1]),
      para("The vendor documents it at docs.vendor.com [1].", [], [1]),
      para("Write to editor@standards.example for a copy [1].", [], [1]),
    ];
    expect(checkReport(input([...GOOD, ...address]))).toEqual({ ok: true, report: { paragraphs: GOOD, dropped: { ADDRESS: 3 } } });
  });

  it("drops a paragraph whose text holds a secret by the product's patterns (SECRET)", () => {
    expect(checkReport(input([...GOOD, para(`The page pasted a key: ${PEM_LINE} [1].`, [], [1])]))).toEqual({ ok: true, report: { paragraphs: GOOD, dropped: { SECRET: 1 } } });
  });

  it("drops a paragraph that tells the reader to act on plant equipment, by the scope sensor's vocabulary (OT)", () => {
    expect(checkReport(input([...GOOD, para(OT_PARAGRAPH, [], [1])]))).toEqual({ ok: true, report: { paragraphs: GOOD, dropped: { OT: 1 } } });
    expect(checkReport(input([para("Force the setpoint on P-101 to its old value [1].", ["21.3"], [1]), ...GOOD]))).toEqual({ ok: true, report: { paragraphs: GOOD, dropped: { OT: 1 } } });
    /* the book's own vocabulary is not plant: "start the run", "set the budget" */
    const book = para("Section 21.3 says to set the budget before you start the run [1].", ["21.3"], [1]);
    expect(checkReport(input([book]))).toEqual({ ok: true, report: { paragraphs: [book], dropped: {} } });
  });

  it("drops what falls past the 600th word of the report as kept, the crossing paragraph and every one after it (WORDS)", () => {
    const long = [para(words(250), [], [1]), para(words(250), [], [1]), para(words(150), [], [1]), para(words(20), [], [1])];
    const verdict = checkReport(input(long));
    expect(verdict).toEqual({ ok: true, report: { paragraphs: long.slice(0, 2), dropped: { WORDS: 2 } } });
    /* a paragraph dropped by another rule does not count toward the 600 */
    const after = [para(words(400, "[7]"), [], [7]), para(words(300), [], [1]), para(words(350), [], [1])];
    expect(checkReport(input(after))).toEqual({ ok: true, report: { paragraphs: [after[1]], dropped: { PAGE: 1, WORDS: 1 } } });
    /* exactly 600 is within */
    const exact = [para(words(300), [], [1]), para(words(300), [], [1])];
    expect(checkReport(input(exact))).toEqual({ ok: true, report: { paragraphs: exact, dropped: {} } });
  });

  it("names the first rule that holds, in the spec's order", () => {
    expect(checkReport(input([...GOOD, para("See https://a.example/x and section 27.1 [9].", ["27.1"], [9])]))).toMatchObject({ ok: true, report: { dropped: { SECTION: 1 } } });
    expect(checkReport(input([...GOOD, para(`See https://a.example/x ${PEM_LINE} [9].`, [], [9])]))).toMatchObject({ ok: true, report: { dropped: { PAGE: 1 } } });
    expect(checkReport(input([...GOOD, para(`See https://a.example/x ${PEM_LINE} [1].`, [], [1])]))).toMatchObject({ ok: true, report: { dropped: { ADDRESS: 1 } } });
  });

  it("fails a report left with nothing, with the counts by rule and no text", () => {
    const verdict = checkReport(input([para("In short, the book is right.", [], []), para("See https://a.example/x [1].", [], [1]), para(OT_PARAGRAPH, ["21.3"], [])]));
    expect(verdict).toEqual({ ok: false, dropped: { NO_REFERENCE: 1, ADDRESS: 1, OT: 1 } });
    expect(Object.keys(verdict.ok ? {} : verdict.dropped).every((rule) => (REPORT_DROP_RULES as ReadonlyArray<string>).includes(rule))).toBe(true);
    expect(checkReport(input([]))).toEqual({ ok: false, dropped: {} });
  });
});
