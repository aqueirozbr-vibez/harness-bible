import { describe, expect, it } from "vitest";

import { suggestionTraceId, workflowTraceId } from "@/lib/telemetry/subjects";

import { traceOf, type TraceLookups } from "./traceOf";

/*
 * The trace's resolution, one case for each row of feature-specs/49 § 7.2, on fake reads: the pure rows read nothing,
 * the three reads are asked by the id the workflow's id names, and a read that fails or finds nothing falls back to the
 * workflow's derived trace with one warning naming the type and the error's name.
 */

const ITEM = "4f1c9a2e-0000-4000-8000-0000000000a1";
const RUN = "33333333-3333-4333-8333-333333333333";
const MESSAGE = "55555555-5555-4555-8555-555555555555";
const FINDING = "66666666-6666-4666-8666-666666666666";
const RUN_TRACE = "0af7651916cd43dd8448eb211c80319c";

function lookups(overrides: Partial<TraceLookups> = {}): { readonly lookups: TraceLookups; readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    lookups: {
      suggestionOfEvidenceItem: (itemId) => {
        asked.push(`item:${itemId}`);
        return Promise.resolve(itemId === ITEM ? "S-21-0016" : null);
      },
      researchTraceOf: (id) => {
        asked.push(`research:${id}`);
        return Promise.resolve(id === RUN || id === MESSAGE ? { runId: RUN, traceId: RUN_TRACE } : null);
      },
      researchTraceOfFinding: (findingId) => {
        asked.push(`finding:${findingId}`);
        return Promise.resolve(findingId === FINDING ? { runId: RUN, traceId: RUN_TRACE } : null);
      },
      ...overrides,
    },
  };
}

describe("traceOf (49 § 7.2)", () => {
  it("files a suggestion's and its merge's activities under the suggestion's trace, reading nothing", async () => {
    const { lookups: reads, asked } = lookups();
    const warnings: string[] = [];
    expect(await traceOf("SuggestionWorkflow", "suggestion:S-21-0016", reads, (line) => warnings.push(line))).toEqual({ traceId: suggestionTraceId("S-21-0016"), trace: { name: "suggestion", tags: ["suggestion"], metadata: { suggestion_id: "S-21-0016" } }, legacy: false, runId: null });
    expect(await traceOf("MergeWorkflow", "merge:S-21-0016", reads, (line) => warnings.push(line))).toMatchObject({ traceId: suggestionTraceId("S-21-0016"), trace: { name: "suggestion" } });
    expect(asked).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("files an evidence item's grade under its suggestion's trace, by one read of the item", async () => {
    const { lookups: reads, asked } = lookups();
    expect(await traceOf("GradeEvidenceWorkflow", `evidence:${ITEM}`, reads, () => undefined)).toEqual({ traceId: suggestionTraceId("S-21-0016"), trace: { name: "suggestion", tags: ["suggestion"], metadata: { suggestion_id: "S-21-0016" } }, legacy: false, runId: null });
    expect(asked).toEqual([`item:${ITEM}`]);
  });

  it("files a person's run under its stored trace with its id, and a legacy run under its turn's with no trace attribute", async () => {
    const { lookups: reads, asked } = lookups();
    expect(await traceOf("ResearchRunWorkflow", `research:${RUN}`, reads, () => undefined)).toEqual({ traceId: RUN_TRACE, trace: { name: "research.run", tags: ["research"], metadata: { run_id: RUN } }, legacy: false, runId: RUN });
    expect(await traceOf("ResearchWorkflow", `research:${MESSAGE}`, reads, () => undefined)).toEqual({ traceId: RUN_TRACE, legacy: true, runId: RUN });
    expect(asked).toEqual([`research:${RUN}`, `research:${MESSAGE}`]);
  });

  it("files a finding's send under its run's trace", async () => {
    const { lookups: reads } = lookups();
    expect(await traceOf("SendFindingWorkflow", `finding:${FINDING}`, reads, () => undefined)).toEqual({ traceId: RUN_TRACE, trace: { name: "research.run", tags: ["research"], metadata: { run_id: RUN } }, legacy: false, runId: RUN });
  });

  it("files an export, the proving run and any other workflow under the workflow's derived trace, reading nothing", async () => {
    const { lookups: reads, asked } = lookups();
    const warnings: string[] = [];
    const exportId = `export:${RUN}`;
    expect(await traceOf("ExportWorkflow", exportId, reads, (line) => warnings.push(line))).toEqual({ traceId: workflowTraceId(exportId), trace: { name: "export", tags: ["export"], metadata: { workflow_id: exportId } }, legacy: false, runId: null });
    expect(await traceOf("ProvingWorkflow", `proving:${RUN}`, reads, (line) => warnings.push(line))).toMatchObject({ traceId: workflowTraceId(`proving:${RUN}`), trace: { name: "engine.check", tags: ["check"] } });
    expect(await traceOf("SomeOtherWorkflow", "other:1", reads, (line) => warnings.push(line))).toEqual({ traceId: workflowTraceId("other:1"), legacy: false, runId: null });
    expect(asked).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("falls back to the derived trace where a read finds nothing or fails, with one warning naming the type and the error's name", async () => {
    const warnings: string[] = [];
    const gone = "77777777-7777-4777-8777-777777777777";
    const { lookups: reads } = lookups();
    expect(await traceOf("ResearchRunWorkflow", `research:${gone}`, reads, (line) => warnings.push(line))).toEqual({ traceId: workflowTraceId(`research:${gone}`), trace: { name: "research.run", tags: ["research"], metadata: {} }, legacy: false, runId: null });
    expect(await traceOf("GradeEvidenceWorkflow", `evidence:${gone}`, reads, (line) => warnings.push(line))).toMatchObject({ traceId: workflowTraceId(`evidence:${gone}`), trace: { name: "suggestion", metadata: {} } });
    const failing = lookups({ researchTraceOfFinding: () => Promise.reject(new TypeError("connection to 10.0.0.5 refused for finding text")) }).lookups;
    expect(await traceOf("SendFindingWorkflow", `finding:${FINDING}`, failing, (line) => warnings.push(line))).toMatchObject({ traceId: workflowTraceId(`finding:${FINDING}`), legacy: false });
    /* a legacy run whose read failed keeps its mark and sets no trace attribute */
    const legacy = await traceOf("ResearchWorkflow", `research:${gone}`, reads, (line) => warnings.push(line));
    expect(legacy).toEqual({ traceId: workflowTraceId(`research:${gone}`), legacy: true, runId: null });
    expect(warnings).toEqual([
      "telemetry: ResearchRunWorkflow's activity is filed under its workflow's own trace (NOT_FOUND)",
      "telemetry: GradeEvidenceWorkflow's activity is filed under its workflow's own trace (NOT_FOUND)",
      "telemetry: SendFindingWorkflow's activity is filed under its workflow's own trace (TypeError)",
      "telemetry: ResearchWorkflow's activity is filed under its workflow's own trace (NOT_FOUND)",
    ]);
    expect(warnings.join("\n")).not.toContain("10.0.0.5");
  });
});
