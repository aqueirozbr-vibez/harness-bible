import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { getPrisma } from "@/lib/db/client";
import { currentRelease } from "@/lib/db/shared";
import { withSystem } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import type { AnswerRequest } from "@/lib/schemas/assistant";
import { GoldenItemSchema, type GoldenItem } from "@/lib/schemas/golden";
import { parseReleaseId, type ReleaseId } from "@/lib/schemas/ids";
import { scopeRules } from "@/lib/sensors/scope";
import { chaptersVerifiedFor, unverifiedChapters, unverifiedLine } from "@/workers/answer/run";

/*
 * `R-UNVERIFIED` without a context chapter (feature-specs/23 § 5.2, § 12.2), against the release in the database:
 * a turn is asked of what its mode picked and of what its question names, and of nothing else. The golden set is
 * the calibration, as for every scope rule. Skipped without DATABASE_URL.
 */

const hasDatabase = env.DATABASE_URL !== undefined;

const ITEMS: ReadonlyArray<GoldenItem> = readFileSync(join(import.meta.dirname, "..", "..", "golden", "assistant", "2026.09.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => GoldenItemSchema.parse(JSON.parse(line)));

const NONE = { chapter: null, section: null } as const;

describe.skipIf(!hasDatabase)("the unverified rule since Assistant 2.0 (feature-specs/23 § 5.2)", () => {
  let releaseId: ReleaseId;
  let verified: number;
  let unverified: number;

  const asked = (question: string, mode: AnswerRequest["mode"] = "explain", context: AnswerRequest["context"] = NONE) => chaptersVerifiedFor({ releaseId, mode, context, question });

  beforeAll(async () => {
    releaseId = parseReleaseId((await currentRelease()).id);
    const rows = await withSystem(async () => getPrisma().chapterVersion.findMany({ where: { releaseId }, orderBy: { chapterNumber: "asc" }, select: { chapterNumber: true, verifyStatus: true } }));
    const passed = rows.filter((row) => row.verifyStatus === "PASSED").map((row) => row.chapterNumber);
    const failing = rows.filter((row) => row.verifyStatus !== "PASSED").map((row) => row.chapterNumber);
    /* The cases below need one chapter of each kind; release 2026.09 has 34 and 7. */
    expect(passed.length).toBeGreaterThan(0);
    expect(failing.length).toBeGreaterThan(0);
    verified = passed.includes(21) ? 21 : (passed[0] ?? 0);
    unverified = failing.includes(34) ? 34 : (failing[0] ?? 0);
  });

  it("refuses every golden question about an unverified chapter on what the question names", async () => {
    const items = ITEMS.filter((item) => item.expected.refusal?.cause === "R-UNVERIFIED");
    expect(items.length).toBeGreaterThanOrEqual(12);
    for (const item of items) expect(await asked(item.question, item.mode), `${item.id}: ${item.question}`).toBe(false);
  });

  it("lets every explain question that expects an answer through", async () => {
    const items = ITEMS.filter((item) => item.mode === "explain" && item.expected.refusal === null);
    expect(items.length).toBeGreaterThanOrEqual(201);
    const refused: string[] = [];
    for (const item of items) if (!(await asked(item.question))) refused.push(`${item.id}: ${item.question}`);
    expect(refused).toEqual([]);
  });

  it("no longer refuses a question for where it was asked: the six items asked from chapters 35 and 37 reach their own rule", async () => {
    const six = ITEMS.filter((item) => ["G-0252", "G-0256", "G-0260", "G-0264", "G-0268", "G-0272"].includes(item.id));
    expect(six).toHaveLength(6);
    for (const item of six) {
      const chaptersVerified = await asked(item.question);
      expect(chaptersVerified, `${item.id}: ${item.question}`).toBe(true);
      /* The plant-operation three refuse by rule; the out-of-scope three are the classifier's, so the rules pass them on. */
      expect(scopeRules({ question: item.question, chaptersVerified }).cause, item.id).toBe(item.expected.refusal?.cause === "R-SCOPE-OT" ? "R-SCOPE-OT" : null);
    }
  });

  it("refuses a question that names a verified and an unverified chapter (D5)", async () => {
    expect(await asked(`Does chapter ${String(verified)} agree with chapter ${String(unverified)}?`)).toBe(false);
    expect(await asked(`What does chapter ${String(verified)} say?`)).toBe(true);
    expect(await asked(`What does section ${String(unverified)}.8 compute?`)).toBe(false);
    expect(await asked(`What does Lab ${String(unverified)} reproduce?`)).toBe(false);
  });

  it("never refuses on a bare number that looks like a section of an unverified chapter", async () => {
    expect(await asked(`Is ${String(unverified)}.8 % the right share?`)).toBe(true);
  });

  it("judges what the mode picked: the pair of a compare, the aid's chapter of a walk, the lab's chapter", async () => {
    expect(await asked("Where do they agree?", "compare", { ...NONE, chapters: [verified, unverified] })).toBe(false);
    expect(await asked("Walk it with our inputs", "walk", { chapter: unverified, section: null })).toBe(false);
    expect(await asked("Walk it with our inputs", "walk", { chapter: verified, section: null })).toBe(true);
    expect(await asked("What does it reproduce?", "lab", { chapter: unverified, section: null, labId: `lab-${String(unverified)}` })).toBe(false);
    expect(await asked("What does it reproduce?", "lab", { chapter: verified, section: null, labId: `lab-${String(verified)}` })).toBe(true);
  });

  it("tells the classifier which chapters are unverified, by number and title", async () => {
    const chapters = await unverifiedChapters(releaseId);
    expect(chapters.map((chapter) => chapter.number)).toContain(unverified);
    expect(chapters.every((chapter) => chapter.title.length > 0)).toBe(true);
    const line = unverifiedLine(chapters);
    expect(line).toContain("R-UNVERIFIED: asks about one of these chapters by its number or its title");
    for (const chapter of chapters) expect(line).toContain(`${String(chapter.number)} ${chapter.title}`);
  });
});

describe("the classifier's line for unverified chapters (feature-specs/23 D6)", () => {
  it("is absent when every chapter is verified, so the prompt is the one it always was", () => {
    expect(unverifiedLine([])).toBe("");
  });

  it("names each chapter by number and title", () => {
    expect(unverifiedLine([{ number: 34, title: "Selecting use cases" }, { number: 36, title: "Regulation" }])).toBe(
      " R-UNVERIFIED: asks about one of these chapters by its number or its title; they have not passed verification: 34 Selecting use cases; 36 Regulation.",
    );
  });
});
