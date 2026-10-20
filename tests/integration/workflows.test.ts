import { randomUUID } from "node:crypto";

import { Client, Connection } from "@temporalio/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { head } from "@/lib/db/ledger";
import { currentRelease } from "@/lib/db/shared";
import { env } from "@/lib/env";
import { PROVING_QUERY, PROVING_SIGNAL, PROVING_WORKFLOW, ProvingResultSchema, provingWorkflowId } from "@/lib/schemas/workflows";
import { closeWorkflowsEngines, queryWorkflow, sdkEngine, signalWorkflow, startWorkflow, workflowRunning, WORKFLOWS_DEADLINE_MS, WorkflowNotFoundError, type WorkflowsClientDeps } from "@/lib/workflows/client";
import { engineConfigOf } from "@/workers/env";
import { PROBE_DEADLINE_MS } from "@/workers/health";
import { checkEngine, startEngine, type RunningEngine } from "@/workers/temporal";

import { holdSdkLogs } from "../workflows/environment";

/*
 * The workflow engine for real (feature-specs/28 § 6): ProvingWorkflow on the compose service, run by the workers'
 * own worker (`startEngine`: the connection, the bundle, the real activities) against the product's database.
 * tests/workflows/ holds what a workflow decides, on a test server with doubled activities; this holds that the
 * pieces meet: the bundle loads in a real worker, the activities read real rows, the engine carries a signal, and
 * the web tier's client (lib/workflows/client.ts) starts, asks and signals through the SDK.
 *
 * The worker polls a task queue of this run's own, so a `npm run workers` on the same machine is never handed the
 * suite's task, nor the suite the product's. What the suite starts it deletes again.
 */

const hasDatabase = env.DATABASE_URL !== undefined;
/** The engine's twin of `hasDatabase`: the suite runs where TEMPORAL_ADDRESS names an engine (.env.example). */
const hasTemporal = env.TEMPORAL_ADDRESS !== undefined;

describe.skipIf(!hasDatabase || !hasTemporal)("the proving workflow on the compose engine", () => {
  const config = engineConfigOf({ address: env.TEMPORAL_ADDRESS, namespace: env.TEMPORAL_NAMESPACE }) ?? { address: "", namespace: "" };
  const taskQueue = `hb-test-${randomUUID()}`;
  const started: string[] = [];
  let engine: RunningEngine | null = null;
  let connection: Connection | null = null;
  holdSdkLogs();

  /*
   * The web tier's client as a route handler has it, but for one thing: it sends a workflow to the workflow's own
   * task queue, which here is this run's, for the reason above. Everything else is the client's and the SDK's.
   */
  const deps: WorkflowsClientDeps = {
    ...config,
    deadlineMs: WORKFLOWS_DEADLINE_MS,
    engine: (at) => {
      const real = sdkEngine(at);
      return { ...real, start: (call, bound) => real.start({ ...call, taskQueue }, bound) };
    },
  };

  const direct = (): Client => {
    if (connection === null) expect.fail("the suite's connection was not made");
    return new Client({ connection, namespace: config.namespace });
  };

  beforeAll(async () => {
    engine = await startEngine(config, [taskQueue]);
    connection = await Connection.connect({ address: config.address });
  }, 60_000);

  afterAll(async () => {
    for (const workflowId of started) {
      await connection?.workflowService.deleteWorkflowExecution({ namespace: config.namespace, workflowExecution: { workflowId } });
    }
    await closeWorkflowsEngines();
    await connection?.close();
    await engine?.stop();
  });

  it("runs on the real activities, takes the signal, and returns the release and the ledger's head", async () => {
    const token = randomUUID();
    const workflowId = provingWorkflowId(token);
    started.push(workflowId);

    /* Other suites append to the ledger while this one runs, so the head is read on both sides of the workflow. */
    const before = (await head())?.seq ?? 0;
    const handle = await direct().workflow.start(PROVING_WORKFLOW, { taskQueue, workflowId, args: [{ token }] });
    await handle.signal(PROVING_SIGNAL);
    const result = ProvingResultSchema.parse(await handle.result());
    const after = (await head())?.seq ?? 0;

    expect(result.signalled).toBe(true);
    expect(result.releaseId).toBe((await currentRelease()).id);
    expect(result.headSeq).toBeGreaterThanOrEqual(before);
    expect(result.headSeq).toBeLessThanOrEqual(after);
  });

  it("answers the health check's question for its namespace, and refuses it for one nobody registered", async () => {
    await expect(checkEngine(config, PROBE_DEADLINE_MS)).resolves.toBeUndefined();
    await expect(checkEngine({ ...config, namespace: `${config.namespace}-nobody-registered` }, PROBE_DEADLINE_MS)).rejects.toThrow();
  });

  it("is started, asked and signalled through the web tier's client, and a second start is handed the same run", async () => {
    const token = randomUUID();
    const id = provingWorkflowId(token);
    started.push(id);

    const first = await startWorkflow(PROVING_WORKFLOW, id, { token }, deps);
    expect(first.workflowId).toBe(id);
    expect(await startWorkflow(PROVING_WORKFLOW, id, { token }, deps)).toEqual(first);

    await vi.waitFor(async () => expect(await queryWorkflow(PROVING_WORKFLOW, id, PROVING_QUERY, deps)).toBe("waiting"), { timeout: 10_000 });
    /* the sweep's question (feature-specs/45 § 3.5): running while it waits */
    expect(await workflowRunning(PROVING_WORKFLOW, id, deps)).toBe(true);
    await signalWorkflow(PROVING_WORKFLOW, id, PROVING_SIGNAL, null, deps);

    /* The client has no call that waits for a result, because the web tier never waits for one. The suite asks the engine. */
    const result = ProvingResultSchema.parse(await direct().workflow.getHandle(id).result());
    expect(result.signalled).toBe(true);
    expect(await queryWorkflow(PROVING_WORKFLOW, id, PROVING_QUERY, deps)).toBe("done");
    expect(await workflowRunning(PROVING_WORKFLOW, id, deps)).toBe(false);

    /* It has ended: a signal has nowhere to go, and the client says so instead of calling the engine unavailable. */
    await expect(signalWorkflow(PROVING_WORKFLOW, id, PROVING_SIGNAL, null, deps)).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it("is told that nothing runs under an id nobody started, and that the engine is unavailable under a namespace nobody registered", async () => {
    const token = randomUUID();
    const absent = provingWorkflowId(token);
    await expect(signalWorkflow(PROVING_WORKFLOW, absent, PROVING_SIGNAL, null, deps)).rejects.toMatchObject({ name: "WorkflowNotFoundError", code: "NOT_FOUND", workflowId: absent });
    await expect(queryWorkflow(PROVING_WORKFLOW, absent, PROVING_QUERY, deps)).rejects.toBeInstanceOf(WorkflowNotFoundError);
    /* an id the engine never knew does not run: the sweep may delete a row whose workflow is gone (45 § 3.5) */
    expect(await workflowRunning(PROVING_WORKFLOW, absent, deps)).toBe(false);
    await expect(startWorkflow(PROVING_WORKFLOW, absent, { token }, { ...deps, namespace: `${config.namespace}-nobody-registered` })).rejects.toMatchObject({ code: "WORKFLOWS_UNAVAILABLE", cause: "unconfigured" });
  });
});
