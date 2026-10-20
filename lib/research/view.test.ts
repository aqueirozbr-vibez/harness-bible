import { describe, expect, it } from "vitest";

import type { ResearchMarkRow } from "@/lib/research/view";
import type { ProposalView } from "@/lib/schemas/api";
import { BUDGET_MARK, markOfQuestion, markOfSection, RESEARCH_SKIPS, RESEARCH_STATES } from "@/lib/schemas/research";

import { daysAgo, daysOf, resetsAtOf, researchLineOf, researchViewOf, researchViewOfStarted } from "./view";

/*
 * The run as the line reads it (feature-specs/43 § 4.2, § 4.3; unit 60a): every state and every skip has a line; the
 * days come from the marks that stand (the newest section's for DEDUPED, the question's for SAME_QUESTION); the reset
 * from the budget mark; the running states are followed and the ended ones are not; the final event's seed is whole.
 */

const NOW = new Date("2026-10-10T12:00:00.000Z");
const Q = "a".repeat(64);
const run = (over: Partial<Parameters<typeof researchViewOf>[0]> = {}) => ({ state: "SKIPPED" as const, skip: null, sectionAnchors: ["21.3", "21.4"], questionSha256: Q, ...over });
const mark = (key: string, daysBack: number, until: Date | null = null): ResearchMarkRow => ({ key, at: new Date(NOW.getTime() - daysBack * 86_400_000 - 3_600_000), until });
/** A proposal as the panel is shown it (43 § 5.3); the line counts them. */
const proposal = (suggestionId: string): ProposalView => ({
  suggestionId,
  anchor: { kind: "SECTION", id: "21.3", section: "21.3", title: "Idempotency keys" },
  changeKind: "ADD_CLAIM",
  changeClass: "NEW_CLAIM",
  curatorReason: null,
  change: { before: null, after: "Keys are kept for at least 24 hours." },
  contentLang: "en",
  sources: [{ host: "standards.example", tier: "B", adjusted: 85 }],
  score: 85,
  acceptAt: 85,
  note: "The standard says so.",
  where: { state: "CURATOR_QUEUE", parts: ["P3"], decisionBy: "2026-10-17T12:00:00.000Z", version: null, closedBy: null },
  endorsed: null,
});

describe("the research view", () => {
  it("counts whole days, never negative", () => {
    expect(daysAgo(new Date(NOW.getTime() - 86_400_000 * 12 - 1_000), NOW)).toBe(12);
    expect(daysAgo(new Date(NOW.getTime() - 1_000), NOW)).toBe(0);
    expect(daysAgo(new Date(NOW.getTime() + 86_400_000), NOW)).toBe(0);
  });

  it("takes the days from the newest cited section's mark for DEDUPED and from the question's mark for SAME_QUESTION, else none", () => {
    const marks = [mark(markOfSection("21.3"), 12), mark(markOfSection("21.4"), 3), mark(markOfQuestion(Q), 7)];
    expect(daysOf(run({ skip: "DEDUPED" }), marks, NOW)).toBe(3);
    expect(daysOf(run({ skip: "SAME_QUESTION" }), marks, NOW)).toBe(7);
    expect(daysOf(run({ skip: "DAILY_LIMIT" }), marks, NOW)).toBeNull();
    expect(daysOf(run({ skip: "DEDUPED", sectionAnchors: ["22.1"] }), marks, NOW)).toBeNull();
  });

  it("takes the reset from the budget mark for a turn skipped at the cap and a run waiting for it, else none", () => {
    const until = new Date("2026-11-01T00:00:00.000Z");
    const marks = [mark(BUDGET_MARK, 0, until)];
    expect(resetsAtOf(run({ skip: "BUDGET" }), marks)).toEqual(until);
    expect(resetsAtOf(run({ state: "WAITING_BUDGET", skip: null }), marks)).toEqual(until);
    expect(resetsAtOf(run({ skip: "DEDUPED" }), marks)).toBeNull();
    expect(resetsAtOf(run({ skip: "BUDGET" }), [])).toBeNull();
  });

  it("builds the view with its proposals whole, and the seed from the final event with none", () => {
    expect(researchViewOf(run({ state: "DONE", skip: null }), [], [proposal("S-21-0101")], NOW)).toEqual({ state: "DONE", skip: null, days: null, resetsAt: null, proposals: [proposal("S-21-0101")] });
    expect(researchViewOfStarted({ state: "SKIPPED", skip: "DEDUPED", runId: null, days: 12, resetsAt: null })).toEqual({ state: "SKIPPED", skip: "DEDUPED", days: 12, resetsAt: null, proposals: [] });
  });

  it("reads a final of workers older than the web, which has neither number, as having none (review of unit 60)", () => {
    const older = researchViewOfStarted({ state: "QUEUED", skip: null, runId: "r" } as unknown as Parameters<typeof researchViewOfStarted>[0]);
    expect(older).toEqual({ state: "QUEUED", skip: null, days: null, resetsAt: null, proposals: [] });
    const line = researchLineOf({ state: "SKIPPED", skip: "BUDGET", proposals: [] } as unknown as Parameters<typeof researchLineOf>[0]);
    expect(line).toMatchObject({ resetsAt: null, days: null });
  });
});

describe("the research line", () => {
  const view = (over: Partial<Parameters<typeof researchLineOf>[0]> = {}) => ({ state: "DONE" as const, skip: null, days: null, resetsAt: null, proposals: [], ...over });

  it("gives every state and every skip a line, the running ones followed and the ended ones not", () => {
    for (const state of RESEARCH_STATES) {
      const line = researchLineOf(view({ state, skip: state === "SKIPPED" ? "UNAVAILABLE" : null }));
      expect(line.follow).toBe(state === "QUEUED" || state === "PLANNING" || state === "READING" || state === "VALIDATING" || state === "SUBMITTING" || state === "WRITING");
      expect(line.key).not.toBe("none");
    }
    for (const skip of RESEARCH_SKIPS) {
      const line = researchLineOf(view({ state: "SKIPPED", skip }));
      expect(line.follow).toBe(false);
      expect(line.key === "none").toBe(skip === "NOT_AN_ANSWER");
    }
  });

  it("maps the states to their words and hues (43 § 4.2)", () => {
    expect(researchLineOf(view({ state: "QUEUED" }))).toMatchObject({ key: "queued", tone: "run" });
    expect(researchLineOf(view({ state: "PLANNING" }))).toMatchObject({ key: "queued", tone: "run" });
    expect(researchLineOf(view({ state: "READING" }))).toMatchObject({ key: "reading", tone: "run" });
    expect(researchLineOf(view({ state: "VALIDATING" }))).toMatchObject({ key: "checking", tone: "run" });
    expect(researchLineOf(view({ state: "SUBMITTING" }))).toMatchObject({ key: "checking", tone: "run" });
    expect(researchLineOf(view({ state: "DONE", proposals: [proposal("S-21-0101"), proposal("S-21-0102")] }))).toMatchObject({ key: "proposals", tone: "ok", n: 2 });
    expect(researchLineOf(view({ state: "DONE" }))).toMatchObject({ key: "nothing", tone: "mute" });
    expect(researchLineOf(view({ state: "WAITING_BUDGET", resetsAt: "2026-11-01T00:00:00.000Z" }))).toMatchObject({ key: "waiting", tone: "warn", resetsAt: new Date("2026-11-01T00:00:00.000Z") });
    expect(researchLineOf(view({ state: "FAILED" }))).toMatchObject({ key: "failed", tone: "mute" });
  });

  it("maps the skips to their words: the budget's two readings, the days, the day's count, and a legacy `off` with no switch to offer (48 § 9.3)", () => {
    expect(researchLineOf(view({ state: "SKIPPED", skip: "BUDGET", resetsAt: "2026-11-01T00:00:00.000Z" }))).toMatchObject({ key: "budget", tone: "mute", resetsAt: new Date("2026-11-01T00:00:00.000Z") });
    expect(researchLineOf(view({ state: "SKIPPED", skip: "DEDUPED", days: 12 }))).toMatchObject({ key: "deduped", days: 12 });
    expect(researchLineOf(view({ state: "SKIPPED", skip: "SAME_QUESTION", days: 0 }))).toMatchObject({ key: "sameQuestion", days: 0 });
    expect(researchLineOf(view({ state: "SKIPPED", skip: "DAILY_LIMIT" }))).toMatchObject({ key: "dailyLimit", n: 30 });
    expect(researchLineOf(view({ state: "SKIPPED", skip: "NO_CITATION" }))).toMatchObject({ key: "noCitation" });
    expect(researchLineOf(view({ state: "SKIPPED", skip: "OFF_USER" }))).toEqual({ key: "off", tone: "mute", follow: false, n: null, days: null, resetsAt: null });
    expect(researchLineOf(view({ state: "SKIPPED", skip: "OFF_ORGANISATION" }))).toEqual({ key: "offOrganisation", tone: "mute", follow: false, n: null, days: null, resetsAt: null });
    expect(researchLineOf(view({ state: "SKIPPED", skip: "NOTHING_TO_RESEARCH" }))).toMatchObject({ key: "nothing" });
    expect(researchLineOf(view({ state: "SKIPPED", skip: "TEXT_PURGED" }))).toMatchObject({ key: "notRun" });
    expect(researchLineOf(view({ state: "SKIPPED", skip: "UNAVAILABLE" }))).toMatchObject({ key: "notRun" });
    expect(researchLineOf(view({ state: "SKIPPED", skip: "NOT_AN_ANSWER" }))).toMatchObject({ key: "none" });
  });
});
