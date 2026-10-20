import "dotenv/config";

import { randomUUID } from "node:crypto";

import { Client, Connection } from "@temporalio/client";

import { env } from "@/lib/env";
import { PROVING_SIGNAL, PROVING_WORKFLOW, ProvingInputSchema, ProvingResultSchema, provingWorkflowId, TASK_QUEUES } from "@/lib/schemas/workflows";

/*
 * npm run workflows:check (feature-specs/28 § 4.5): starts one ProvingWorkflow on the engine TEMPORAL_ADDRESS
 * names, signals it, waits for its result and prints one line. It needs the workers running (`npm run workers`),
 * since they are what executes it.
 *
 *   npm run workflows:check                 start, signal `proceed`, print the result
 *   npm run workflows:check -- --no-signal  start and wait: the workflow's own one-minute timer ends the wait
 *
 * The second form is the one to use while killing and restarting the workers or the engine in the middle: the
 * workflow must come back and finish by itself.
 */

function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const address = env.TEMPORAL_ADDRESS ?? refuse("TEMPORAL_ADDRESS is not set: the check needs the workflow engine (see .env.example; `docker compose up -d temporal-namespace`).");
  const namespace = env.TEMPORAL_NAMESPACE ?? refuse("TEMPORAL_NAMESPACE is not set (see .env.example).");
  const signal = !process.argv.includes("--no-signal");

  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace });
    const input = ProvingInputSchema.parse({ token: randomUUID() });
    const workflowId = provingWorkflowId(input.token);
    const started = performance.now();
    const handle = await client.workflow.start(PROVING_WORKFLOW, { taskQueue: TASK_QUEUES.improve, workflowId, args: [input] });
    console.log(`workflows: started ${workflowId}${signal ? "" : " without a signal: its own timer of one minute will end the wait"}`);
    if (signal) await handle.signal(PROVING_SIGNAL);
    const result = ProvingResultSchema.parse(await handle.result());
    console.log(`workflows: ${workflowId} → release ${result.releaseId} · ledger head ${String(result.headSeq)} · signalled ${String(result.signalled)} · ${(performance.now() - started).toFixed(0)} ms`);
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  refuse(`workflows: the check failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
});
