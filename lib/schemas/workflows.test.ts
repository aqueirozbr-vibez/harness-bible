import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { freeTextIn } from "./freeText";
import { SuggestionIdSchema } from "./ids";
import * as vocabulary from "./workflows";
import {
  PROVING_QUERY,
  PROVING_SIGNAL,
  PROVING_WORKFLOW,
  ProvingInputSchema,
  ProvingResultSchema,
  ProvingStageSchema,
  provingWorkflowId,
  ProvingWorkflowIdSchema,
  FindingWorkflowIdSchema,
  findingWorkflowId,
  RESEARCH_RUN_WORKFLOW,
  researchRunWorkflowId,
  TASK_QUEUES,
  TemporalAddressSchema,
  TemporalNamespaceSchema,
  WORKFLOWS,
} from "./workflows";

describe("the workflow engine's address and namespace (feature-specs/28 § 3)", () => {
  it("takes a host and a port, as the engine's SDK does", () => {
    for (const address of ["127.0.0.1:7233", "temporal:7233", "engine.internal:443", "a:1", "localhost:65535"]) {
      expect(TemporalAddressSchema.safeParse(address).success, address).toBe(true);
    }
  });

  it("refuses a URL, a bare host, a bare port, a path and a port no machine has", () => {
    for (const address of ["http://127.0.0.1:7233", "127.0.0.1", ":7233", "temporal:7233/", "temporal:0", "temporal:65536", "temporal:123456", "-x:7233", "x-:7233", "tem poral:7233", ""]) {
      expect(TemporalAddressSchema.safeParse(address).success, address).toBe(false);
    }
  });

  it("takes a namespace of lower-case letters, digits and hyphens", () => {
    for (const namespace of ["harness-bible", "hb", "a", "staging-2"]) expect(TemporalNamespaceSchema.safeParse(namespace).success, namespace).toBe(true);
    for (const namespace of ["Harness-Bible", "-hb", "hb-", "harness bible", "harness_bible", ""]) expect(TemporalNamespaceSchema.safeParse(namespace).success, namespace).toBe(false);
  });
});

describe("the task queues and the proving workflow (feature-specs/28 § 4.1, § 4.5)", () => {
  const TOKEN = "77f2989b-15a5-46e4-9946-5ea4103f87d9";

  it("names two queues, one for improve and one for research", () => {
    expect(TASK_QUEUES).toEqual({ improve: "hb-improve", research: "hb-research" });
  });

  it("names the workflow as its function is exported, and its signal", () => {
    expect(PROVING_WORKFLOW).toBe("ProvingWorkflow");
    expect(PROVING_SIGNAL).toBe("proceed");
  });

  it("takes a token that is a uuid and nothing else", () => {
    expect(ProvingInputSchema.safeParse({ token: TOKEN }).success).toBe(true);
    expect(ProvingInputSchema.safeParse({ token: "what is in 21.3?" }).success).toBe(false);
    expect(ProvingInputSchema.safeParse({ token: TOKEN, question: "x" }).success).toBe(false);
    expect(ProvingInputSchema.safeParse({}).success).toBe(false);
  });

  it("returns a release id, the ledger head's seq and whether it was signalled", () => {
    expect(ProvingResultSchema.safeParse({ releaseId: "2026.09", headSeq: 5828, signalled: true }).success).toBe(true);
    expect(ProvingResultSchema.safeParse({ releaseId: "2026.09", headSeq: 0, signalled: false }).success).toBe(true);
    expect(ProvingResultSchema.safeParse({ releaseId: "the ninth release", headSeq: 1, signalled: true }).success).toBe(false);
    expect(ProvingResultSchema.safeParse({ releaseId: "2026.09", headSeq: -1, signalled: true }).success).toBe(false);
    expect(ProvingResultSchema.safeParse({ releaseId: "2026.09", headSeq: 1.5, signalled: true }).success).toBe(false);
  });

  it("derives the workflow's id from the token", () => {
    expect(provingWorkflowId(TOKEN)).toBe(`proving:${TOKEN}`);
  });
});

describe("the table of workflows the web tier's client is typed by (feature-specs/28 § 5)", () => {
  const TOKEN = "77f2989b-15a5-46e4-9946-5ea4103f87d9";

  it("names each workflow as workers/workflows/index.ts exports it, and no other", () => {
    const index = readFileSync(join(import.meta.dirname, "..", "..", "workers", "workflows", "index.ts"), "utf8");
    const exported = [...index.matchAll(/^export \{([^}]+)\} from /gm)].flatMap((match) => (match[1] ?? "").split(",").map((name) => name.trim())).filter((name) => name !== "");
    expect(exported.length).toBeGreaterThan(0);
    expect(Object.keys(WORKFLOWS).sort()).toEqual([...exported].sort());
  });

  it("gives the proving workflow its queue, its signal that carries nothing and its one query", () => {
    const proving = WORKFLOWS[PROVING_WORKFLOW];
    expect(proving.taskQueue).toBe("hb-improve");
    expect(proving.input).toBe(ProvingInputSchema);
    expect(proving.result).toBe(ProvingResultSchema);
    expect(proving.signals).toEqual({ [PROVING_SIGNAL]: null });
    expect(Object.keys(proving.queries)).toEqual([PROVING_QUERY]);
    expect(PROVING_QUERY).toBe("stage");
  });

  it("takes an id of the workflow's own form, the one `provingWorkflowId` writes, and no other", () => {
    expect(ProvingWorkflowIdSchema.safeParse(provingWorkflowId(TOKEN)).success).toBe(true);
    for (const id of [TOKEN, `suggestion:${TOKEN}`, "proving:", "proving:what is in 21.3?", `proving:${TOKEN} `, `Proving:${TOKEN}`]) {
      expect(ProvingWorkflowIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it("answers `stage` with one of four words", () => {
    expect(ProvingStageSchema.options).toEqual(["release", "waiting", "head", "done"]);
    expect(ProvingStageSchema.safeParse("what is in 21.3?").success).toBe(false);
  });
});

describe("ResearchRunWorkflow's entry (feature-specs/48 § 5.1)", () => {
  const RUN = "7d0c5a51-6f8e-4d0a-9d55-2b1f3c6a7e90";
  const USER = "0b3e1f7c-2d9a-4c55-8e61-5a4f3b2c1d0e";

  it("runs on the research queue under research:<runId>, takes the run's id and the asker's and nothing else, and is closed by the engine at 90 minutes", () => {
    const entry = WORKFLOWS[RESEARCH_RUN_WORKFLOW];
    expect(entry.taskQueue).toBe("hb-research");
    expect(entry.executionTimeoutMs).toBe(90 * 60_000);
    expect(entry.id.safeParse(researchRunWorkflowId(RUN)).success).toBe(true);
    expect(entry.input.safeParse({ runId: RUN, userId: USER }).success).toBe(true);
    expect(entry.input.safeParse({ runId: RUN, userId: USER, question: "what is in 21.3?" }).success).toBe(false);
    expect(entry.result.safeParse({ runId: RUN, state: "REFUSED", findings: 0 }).success).toBe(true);
    expect(Object.keys(entry.signals)).toEqual([]);
    expect(Object.keys(entry.queries)).toEqual(["stage"]);
  });

  it("forms a sent finding's workflow id, finding:<uuid>, and refuses any other", () => {
    expect(FindingWorkflowIdSchema.safeParse(findingWorkflowId(RUN)).success).toBe(true);
    for (const id of [RUN, `finding:${RUN} `, "finding:what is in 21.3?", `research:${RUN}`]) expect(FindingWorkflowIdSchema.safeParse(id).success, id).toBe(false);
  });
});

/*
 * feature-specs/28 § 5.3, § 10.9; architecture § 11 invariant 35. The engine keeps every argument and every result
 * it is handed, and the 30-day purge cannot reach them there. This walks everything the file exports, the table of
 * workflows included, so a schema added later is held to the rule without anyone remembering to list it.
 */
describe("nothing a person wrote can cross to the engine", () => {
  function schemasIn(value: unknown, name: string): ReadonlyArray<readonly [string, z.ZodType]> {
    if (value instanceof z.ZodType) return [[name, value]];
    if (typeof value !== "object" || value === null) return [];
    return Object.entries(value).flatMap(([key, inner]) => schemasIn(inner, name === "" ? key : `${name}.${key}`));
  }
  const schemas = schemasIn({ ...vocabulary }, "");

  it("finds the schemas of the file: the ones exported by name and the ones inside the table", () => {
    const names = schemas.map(([name]) => name);
    for (const name of ["TemporalAddressSchema", "ProvingInputSchema", "ProvingResultSchema", "ProvingStageSchema", "ProvingWorkflowIdSchema", "WORKFLOWS.ProvingWorkflow.id", "WORKFLOWS.ProvingWorkflow.input", "WORKFLOWS.ProvingWorkflow.result", "WORKFLOWS.ProvingWorkflow.queries.stage"]) {
      expect(names, name).toContain(name);
    }
  });

  it("finds no place in any of them that could hold a sentence", () => {
    for (const [name, schema] of schemas) expect(freeTextIn(schema), name).toEqual([]);
  });

  it("would find one: a workflow argument with a bare string beside its id is refused, by its path", () => {
    expect(freeTextIn(z.strictObject({ suggestionId: SuggestionIdSchema, note: z.string() }))).toEqual(["$.note: a string with no pattern"]);
    expect(freeTextIn(z.strictObject({ suggestionId: SuggestionIdSchema }))).toEqual([]);
  });
});

