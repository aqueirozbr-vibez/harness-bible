import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { subjectOf, suggestionTraceId, traceAttributesOf, workflowTraceId } from "./subjects";

/*
 * The subjects of feature-specs/49 § 6.1 and § 7.2's pure half: a trace derived from a seed, found again from the seed
 * alone; what each workflow id form names; and each workflow type's trace name, tags and record ids (§ 6.4).
 */

const ITEM = "4f1c9a2e-0000-4000-8000-0000000000a1";
const RUN = "33333333-3333-4333-8333-333333333333";

describe("the derived traces (49 § 6.1)", () => {
  it("are the first 32 hex of sha256 over the seed, the same each time and different by subject", () => {
    expect(suggestionTraceId("S-21-0016")).toBe(createHash("sha256").update("suggestion:S-21-0016").digest("hex").slice(0, 32));
    expect(workflowTraceId("export:44444444-4444-4444-8444-444444444444")).toBe(createHash("sha256").update("workflow:export:44444444-4444-4444-8444-444444444444").digest("hex").slice(0, 32));
    expect(suggestionTraceId("S-21-0016")).toMatch(/^[0-9a-f]{32}$/);
    expect(suggestionTraceId("S-21-0016")).toBe(suggestionTraceId("S-21-0016"));
    /* a suggestion's merge is filed under the suggestion, not under a workflow of its own */
    expect(suggestionTraceId("S-21-0016")).not.toBe(workflowTraceId("suggestion:S-21-0016"));
  });
});

describe("subjectOf (49 § 7.2)", () => {
  it("names the subject of each workflow id form, and nothing for another", () => {
    expect(subjectOf("suggestion:S-21-0016")).toEqual({ kind: "suggestion", suggestionId: "S-21-0016" });
    expect(subjectOf("merge:S-36-0198")).toEqual({ kind: "suggestion", suggestionId: "S-36-0198" });
    expect(subjectOf(`evidence:${ITEM}`)).toEqual({ kind: "evidence", itemId: ITEM });
    expect(subjectOf(`research:${RUN}`)).toEqual({ kind: "research", id: RUN });
    expect(subjectOf(`finding:${ITEM}`)).toEqual({ kind: "finding", findingId: ITEM });
    for (const id of [`export:${RUN}`, `proving:${RUN}`, "suggestion:not-an-id", "evidence:x", "anything"]) expect(subjectOf(id), id).toEqual({ kind: "workflow" });
  });
});

describe("traceAttributesOf (49 § 6.4, § 7.2)", () => {
  it("gives each workflow type its trace name, tags and record id, the legacy research workflow and an unknown type none", () => {
    expect(traceAttributesOf("ResearchRunWorkflow", { workflowId: `research:${RUN}`, runId: RUN })).toEqual({ name: "research.run", tags: ["research"], metadata: { run_id: RUN } });
    expect(traceAttributesOf("SendFindingWorkflow", { workflowId: `finding:${ITEM}`, runId: RUN })).toEqual({ name: "research.run", tags: ["research"], metadata: { run_id: RUN } });
    for (const type of ["SuggestionWorkflow", "GradeEvidenceWorkflow", "MergeWorkflow"]) expect(traceAttributesOf(type, { workflowId: "w", suggestionId: "S-21-0016" }), type).toEqual({ name: "suggestion", tags: ["suggestion"], metadata: { suggestion_id: "S-21-0016" } });
    expect(traceAttributesOf("ExportWorkflow", { workflowId: `export:${RUN}` })).toEqual({ name: "export", tags: ["export"], metadata: { workflow_id: `export:${RUN}` } });
    expect(traceAttributesOf("ProvingWorkflow", { workflowId: `proving:${RUN}` })).toEqual({ name: "engine.check", tags: ["check"], metadata: { workflow_id: `proving:${RUN}` } });
    expect(traceAttributesOf("ResearchWorkflow", { workflowId: `research:${RUN}`, runId: RUN })).toBeUndefined();
    expect(traceAttributesOf("SomeOtherWorkflow", { workflowId: "x" })).toBeUndefined();
    /* a record the read did not find: the name and tags, and no id */
    expect(traceAttributesOf("ResearchRunWorkflow", { workflowId: `research:${RUN}` })).toEqual({ name: "research.run", tags: ["research"], metadata: {} });
  });
});
