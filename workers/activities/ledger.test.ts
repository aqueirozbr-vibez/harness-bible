import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";
import { sha256Hex } from "@/lib/ledger/hash";

import { appendOnce, stepKeyOf, type AppendOnceDeps } from "./ledger";

/* A workflow step's record, written once (feature-specs/28 § 4.4; unit 50a), with the lookup and the append doubled. */

const INPUT = { kind: "GRADED", actor: "service:grader", suggestionId: "S-95-0001", chapterVersionId: "00000000-0000-4000-8000-0000000050a0", payload: {} } as unknown as Parameters<typeof appendOnce>[0];

function depsOf(found: number | null, appended: () => Promise<number>) {
  const calls: string[] = [];
  const deps: AppendOnceDeps = {
    recordAt: (async (suggestionId: string, kind: string, stepKey: string) => {
      calls.push(`recordAt:${suggestionId}:${kind}:${stepKey}`);
      return found === null ? null : { seq: found };
    }) as unknown as AppendOnceDeps["recordAt"],
    append: (async () => {
      calls.push("append");
      return { seq: await appended() };
    }) as unknown as AppendOnceDeps["append"],
  };
  return { deps, calls };
}

describe("stepKeyOf", () => {
  it("is the sha256 of the workflow's id and the step, so another attempt has a key of its own", () => {
    expect(stepKeyOf("suggestion:S-21-0016", "graded:1")).toBe(sha256Hex("suggestion:S-21-0016:graded:1"));
    expect(stepKeyOf("suggestion:S-21-0016", "graded:2")).not.toBe(stepKeyOf("suggestion:S-21-0016", "graded:1"));
  });
});

describe("appendOnce", () => {
  it("answers the record the step already wrote and appends nothing", async () => {
    const { deps, calls } = depsOf(41, async () => 42);
    expect(await appendOnce(INPUT, "k", deps)).toEqual({ seq: 41 });
    expect(calls).toEqual(["recordAt:S-95-0001:GRADED:k"]);
  });

  it("appends when the step wrote none, and answers the new record's seq", async () => {
    const { deps, calls } = depsOf(null, async () => 42);
    expect(await appendOnce(INPUT, "k", deps)).toEqual({ seq: 42 });
    expect(calls).toEqual(["recordAt:S-95-0001:GRADED:k", "append"]);
  });

  it("does not retry a payload's or the columns' refusal, which are the code's error, and leaves anything else to the engine's retry", async () => {
    for (const code of ["LEDGER_PAYLOAD", "LEDGER_COLUMNS"] as const) {
      const failed = await appendOnce(INPUT, "k", depsOf(null, () => Promise.reject(new AppError(code, "refused"))).deps).catch((error: unknown) => error);
      expect(failed, code).toBeInstanceOf(ApplicationFailure);
      expect(failed, code).toMatchObject({ type: code, nonRetryable: true });
    }
    const conflict = new AppError("LEDGER_CONFLICT", "raced");
    await expect(appendOnce(INPUT, "k", depsOf(null, () => Promise.reject(conflict)).deps)).rejects.toBe(conflict);
  });
});
