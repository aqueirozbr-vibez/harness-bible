import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RULED_CAUSES } from "@/lib/improve/evidenceView";

/*
 * The reasons intake rules write on an item that opened, read from the workers' own source, against the form's words
 * (`RULED_CAUSES`, lib/improve/evidenceView.ts; feature-specs/34 § 23). A reason the workers start writing that the
 * form has no words for fails here, rather than reaching a contributor as the grader's sentence, and words the workers
 * no longer write fail too (unit 51d's review). Two codes end an item before it opens, and the form words them by its
 * fetch status instead: `not_supplied` and a DOI's form.
 */

const read = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");
const BEFORE_OPENING = new Set(["not_supplied", "doi_form"]);

describe("the reasons an opened item is graded U by, as the workers write them", () => {
  it("are the reasons the form has words for, no more and no fewer", () => {
    const activity = [...read("workers/activities/evidence.ts").matchAll(/unverifiable\(itemId, "([a-z_]+)"/g)].map((match) => match[1] ?? "");
    const grader = [...read("workers/agents/grader/evidence.ts").matchAll(/unverifiable\("([a-z_]+)"\)/g)].map((match) => match[1] ?? "");
    const media = (/export type MediaRefusal = ([^;]+);/.exec(read("lib/improve/media.ts"))?.[1] ?? "").match(/"[a-z_]+"/g)?.map((code) => code.slice(1, -1)) ?? [];
    expect(activity.length).toBeGreaterThan(0);
    expect(grader).toEqual(["request_too_large"]);
    expect(media).toHaveLength(5);
    const written = new Set([...activity, ...grader, ...media].filter((code) => !BEFORE_OPENING.has(code)));
    expect([...written].sort()).toEqual([...RULED_CAUSES].sort());
  });
});
