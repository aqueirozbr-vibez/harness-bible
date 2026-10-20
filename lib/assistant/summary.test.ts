import { describe, expect, it } from "vitest";

import type { AnswerView, Turn } from "@/lib/assistant/turns";

import { lineOfTurns } from "./summary";

const ANSWER: AnswerView = {
  messageId: "m-1",
  mode: "explain",
  kind: "answer",
  claims: null,
  text: "A retried write without a key is a second write.",
  refusal: null,
  citations: [{ sectionId: "21.3", figureId: null, version: "v1.0.0", editionLang: "EN" }],
  verdicts: [
    { sensor: "scope", verdict: "PASS", detail: "" },
    { sensor: "grader", verdict: "NA", detail: "" },
  ],
  grounded: 0.9,
  citesEdition: "EN",
  firstTokenMs: 900,
  totalMs: 4000,
  ledger: null,
  flag: null,
  traceId: null,
  at: "2026-10-04T10:01:00.000Z",
  walk: null,
  compare: null,
  lab: null,
  brief: null,
  research: null,
};
const turn = (key: string, answer: AnswerView | null, at: string | null = "2026-10-04T10:00:00.000Z"): Turn => ({ key, question: { text: "A question.", at }, mode: "explain", answer });

describe("the open conversation's line (feature-specs/26 § 5)", () => {
  it("counts turns, passes and refusals as the server's list does", () => {
    const line = lineOfTurns("c-1", [
      turn("a", ANSWER),
      turn("b", { ...ANSWER, verdicts: [{ sensor: "citation", verdict: "WARN", detail: "" }], citations: [{ sectionId: "20.1", figureId: null, version: "v1.0.0", editionLang: "EN" }, { sectionId: "21.3", figureId: null, version: "v1.0.0", editionLang: "EN" }] }),
      turn("c", { ...ANSWER, kind: "refusal", refusal: { cause: "R-SCOPE-OT", code: "R-SCOPE-OT", pointers: [], beforeRetrieval: true }, citations: [], at: "2026-10-04T10:09:00.000Z" }),
    ], "2026-10-04T12:00:00.000Z");
    expect(line).toEqual({ id: "c-1", citedChapters: [21, 20], lastMessageAt: "2026-10-04T10:09:00.000Z", turns: 3, passCount: 1, refusedCount: 1 });
  });

  it("is a line with no turns while the first question is still being answered", () => {
    expect(lineOfTurns("c-1", [turn("live", null, "2026-10-04T10:00:00.000Z")], "2026-10-04T12:00:00.000Z")).toEqual({ id: "c-1", citedChapters: [], lastMessageAt: "2026-10-04T10:00:00.000Z", turns: 0, passCount: 0, refusedCount: 0 });
    /* Nothing has a time of its own yet: the caller's clock stands in. */
    expect(lineOfTurns("c-1", [], "2026-10-04T12:00:00.000Z").lastMessageAt).toBe("2026-10-04T12:00:00.000Z");
  });

  it("ignores a lab's pseudo-citation, which names no chapter section", () => {
    const line = lineOfTurns("c-1", [turn("a", { ...ANSWER, citations: [{ sectionId: "lab21", figureId: null, version: "v1.0.0", editionLang: "EN" }, { sectionId: "09.2", figureId: null, version: "v1.0.0", editionLang: "EN" }] })], "2026-10-04T12:00:00.000Z");
    expect(line.citedChapters).toEqual([9]);
  });
});
