import { defineQuery, log, proxyActivities, setHandler } from "@temporalio/workflow";

import { EXPORT_STAGE_QUERY, ExportWorkflowInputSchema, type ExportStage, type ExportWorkflowInput, type ExportWorkflowResult } from "@/lib/schemas/workflows";

import type { ExportActivities } from "./activities";

/*
 * ExportWorkflow (feature-specs/38 § 3; unit 55b), under `export:<id>`: write the audit pack, then record it. The store
 * unavailable is an activity that fails and is tried again, without end and with a growing wait (38 § 5: "the workflow
 * retries; the row stays PREPARING"); nothing is appended to the ledger until the file exists, because the record is
 * the second step. Each step is idempotent on the row: a retry after a step's success writes nothing twice.
 */

const { writeAuditPack } = proxyActivities<Pick<ExportActivities, "writeAuditPack">>({ startToCloseTimeout: "10 minutes", retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "10 minutes" } });
const { recordAuditPack } = proxyActivities<Pick<ExportActivities, "recordAuditPack">>({ startToCloseTimeout: "60 seconds", retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "10 minutes" } });

export const exportStage = defineQuery<ExportStage>(EXPORT_STAGE_QUERY);

export async function ExportWorkflow(rawInput: ExportWorkflowInput): Promise<ExportWorkflowResult> {
  const input = ExportWorkflowInputSchema.parse(rawInput);
  let stage: ExportStage = "WRITING";
  setHandler(exportStage, () => stage);
  log.info("export: writing", { exportId: input.exportId });
  const pack = await writeAuditPack(input.exportId);
  stage = "RECORDING";
  await recordAuditPack(input.exportId, pack);
  stage = "READY";
  log.info("export: ready", { exportId: input.exportId, records: pack.records });
  return { exportId: input.exportId, records: pack.records, headHash: pack.headHash };
}
