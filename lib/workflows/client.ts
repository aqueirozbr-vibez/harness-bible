import {
  Client,
  Connection,
  isGrpcCancelledError,
  isGrpcDeadlineError,
  isGrpcServiceError,
  NamespaceNotFoundError,
  WorkflowNotFoundError as EngineWorkflowNotFoundError,
} from "@temporalio/client";

import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { WORKFLOWS, type QueryAnswer, type QueryName, type SignalInput, type SignalName, type WorkflowDefinition, type WorkflowInput, type WorkflowName } from "@/lib/schemas/workflows";

/*
 * The web tier's side of the workflow engine (feature-specs/28 § 5): start a workflow, signal one, ask one, and since
 * unit 62f ask whether one still runs (feature-specs/45 § 3.5). It is
 * the web tier's only import of the engine's SDK (eslint.config.mjs holds that), and it does four things for every
 * call:
 *
 *   typed by name   the workflow's name picks its entry of WORKFLOWS (lib/schemas/workflows.ts): its task queue,
 *                   the form of its id, the schema of its argument, its signals and its queries;
 *   validated       the id and the argument are parsed before anything is sent, and a query's answer before it is
 *                   returned. Those schemas cannot hold a sentence (lib/schemas/freeText.ts), so no reader's words
 *                   reach a history through here (invariant 35);
 *   bounded         one deadline for the whole call. The SDK retries by itself and was measured to overrun its own
 *                   deadline on a port nothing listens on, so the deadline is enforced here: at it, what is in
 *                   flight is cancelled and the caller has its answer;
 *   fail closed     no address, an engine that cannot be reached or one that does not answer in time is
 *                   `WorkflowsUnavailableError`, a 503, never a hang and never a guess (invariant 23).
 *
 * A start that timed out may still have started: the request can reach the engine as the deadline passes. That is
 * why the id is the deduplication (28 § 4.3): the caller's retry is handed the run that is already there.
 */

export type WorkflowsUnavailableCause = "unconfigured" | "connection" | "timeout" | "malformed";

/** The engine is not configured, could not be reached, did not answer in time, or answered a query with another shape. */
export class WorkflowsUnavailableError extends AppError {
  override readonly cause: WorkflowsUnavailableCause;

  constructor(cause: WorkflowsUnavailableCause, message: string) {
    super("WORKFLOWS_UNAVAILABLE", message);
    this.name = "WorkflowsUnavailableError";
    this.cause = cause;
  }
}

/**
 * The engine answered, and nothing under that id can take the call: no workflow was started as it, or the one that
 * was has ended and a signal has nowhere to go. What that means to a reader is the endpoint's to say.
 */
export class WorkflowNotFoundError extends AppError {
  readonly workflowId: string;

  constructor(workflowId: string) {
    super("NOT_FOUND", `${workflowId}: no workflow under that id can take this`);
    this.name = "WorkflowNotFoundError";
    this.workflowId = workflowId;
  }
}

/**
 * The deadline of a start, a signal or a query, connection included. Each is one round trip, so it is the number
 * the product already gives "is the other process there": the `/health` row's five seconds (feature-specs/11
 * § 7.2; lib/workers/client.ts). The spec's, not this file's (28 § 5).
 */
export const WORKFLOWS_DEADLINE_MS = 5_000;

/** One call's bound: nothing is sent after `at` (milliseconds since the epoch), and `signal` aborts what is in flight. */
export interface CallBound {
  readonly at: number;
  readonly signal: AbortSignal;
}

export interface EngineAddress {
  readonly address: string;
  readonly namespace: string;
}

/**
 * What this client asks of the engine: three calls, each under a bound. `sdkEngine` below is the SDK behind them;
 * the tests beside this file stand in for it.
 */
export interface WorkflowsEngine {
  /** Starts `name` under `workflowId`, or finds the run already there under it; `executionTimeoutMs`, where the workflow's entry has one, is the engine's bound on the whole run (feature-specs/48 § 5.1). */
  start(call: { readonly name: string; readonly workflowId: string; readonly taskQueue: string; readonly input: unknown; readonly executionTimeoutMs?: number }, bound: CallBound): Promise<{ readonly runId: string }>;
  /** `input` is the signal's one argument, or null for a signal that carries nothing. */
  signal(call: { readonly workflowId: string; readonly signal: string; readonly input: unknown }, bound: CallBound): Promise<void>;
  query(call: { readonly workflowId: string; readonly query: string }, bound: CallBound): Promise<unknown>;
  /** Asks the run under `workflowId` to cancel (unit 49e: a pending item's grading when the item is removed). */
  cancel(call: { readonly workflowId: string }, bound: CallBound): Promise<void>;
  /** Whether the latest run under `workflowId` is still running (unit 62f: the sweep of detached research runs). */
  describe(call: { readonly workflowId: string }, bound: CallBound): Promise<{ readonly running: boolean }>;
}

export interface WorkflowsClientDeps {
  readonly address: string | undefined;
  readonly namespace: string | undefined;
  readonly deadlineMs: number;
  readonly engine: (at: EngineAddress) => WorkflowsEngine;
}

export function defaultWorkflowsDeps(): WorkflowsClientDeps {
  return { address: env.TEMPORAL_ADDRESS, namespace: env.TEMPORAL_NAMESPACE, deadlineMs: WORKFLOWS_DEADLINE_MS, engine: sdkEngine };
}

/* ---------------------------------------------------------------- the SDK behind the three calls */

interface Held {
  readonly connection: Connection;
  readonly client: Client;
  /** The SDK's calls that have not settled yet, whatever this client has already told its caller. */
  readonly inFlight: Set<Promise<unknown>>;
}

/*
 * One connection per engine for the life of the process, made without connecting: the first call connects, and a
 * connection that drops is made again by the SDK. It is kept on globalThis as the Prisma client is, because the
 * development server reloads modules and would otherwise leave a connection behind on every reload.
 */
const holder = globalThis as unknown as { hbWorkflowsEngines?: Map<string, Held> };

function held(at: EngineAddress): Held {
  const engines = (holder.hbWorkflowsEngines ??= new Map<string, Held>());
  const key = `${at.address} ${at.namespace}`;
  const existing = engines.get(key);
  if (existing !== undefined) return existing;
  const connection = Connection.lazy({ address: at.address });
  const made = { connection, client: new Client({ connection, namespace: at.namespace }), inFlight: new Set<Promise<unknown>>() };
  engines.set(key, made);
  return made;
}

/** gRPC's status for "the service cannot be reached" (the protocol's own number). */
const GRPC_UNAVAILABLE = 14;

function grpcCode(error: unknown): number | undefined {
  if (isGrpcServiceError(error)) return error.code;
  return error instanceof Error && isGrpcServiceError(error.cause) ? error.cause.code : undefined;
}

/** What the SDK threw, as this client says it. Anything it does not know is passed on as it is, and is a 500. */
function translated(error: unknown, at: EngineAddress): unknown {
  if (error instanceof EngineWorkflowNotFoundError) return new WorkflowNotFoundError(error.workflowId);
  if (error instanceof NamespaceNotFoundError) {
    return new WorkflowsUnavailableError("unconfigured", `the workflow engine has no namespace ${at.namespace}: docker compose up -d temporal-namespace registers it (feature-specs/28 § 3).`);
  }
  if (isGrpcDeadlineError(error) || isGrpcCancelledError(error)) return new WorkflowsUnavailableError("timeout", "the workflow engine did not answer in time");
  if (grpcCode(error) === GRPC_UNAVAILABLE) return new WorkflowsUnavailableError("connection", "the workflow engine could not be reached");
  return error;
}

/** The engine through Temporal's SDK. Exported for the suites that run it against a real engine. */
export function sdkEngine(at: EngineAddress): WorkflowsEngine {
  const { connection, client, inFlight } = held(at);
  const bounded = async <T>(bound: CallBound, call: () => Promise<T>): Promise<T> => {
    const pending = connection.withAbortSignal(bound.signal, () => connection.withDeadline(bound.at, call));
    const settled = (): void => {
      inFlight.delete(pending);
    };
    inFlight.add(pending);
    pending.then(settled, settled);
    try {
      return await pending;
    } catch (error: unknown) {
      throw translated(error, at);
    }
  };
  return {
    start: (call, bound) =>
      bounded(bound, async () => {
        /* USE_EXISTING: a start under an id that is running is handed that run, not refused and not a second one (28 § 4.3).
           The execution timeout closes a run that loops on workflow-task failures, which the SDK retries without end (48 § 5.1). */
        const handle = await client.workflow.start(call.name, {
          taskQueue: call.taskQueue,
          workflowId: call.workflowId,
          args: [call.input],
          workflowIdConflictPolicy: "USE_EXISTING",
          ...(call.executionTimeoutMs === undefined ? {} : { workflowExecutionTimeout: call.executionTimeoutMs }),
        });
        return { runId: handle.firstExecutionRunId };
      }),
    signal: (call, bound) => bounded(bound, () => client.workflow.getHandle(call.workflowId).signal(call.signal, ...(call.input === null ? [] : [call.input]))),
    query: (call, bound) => bounded(bound, () => client.workflow.getHandle(call.workflowId).query<unknown>(call.query)),
    cancel: (call, bound) =>
      bounded(bound, async () => {
        await client.workflow.getHandle(call.workflowId).cancel();
      }),
    describe: (call, bound) =>
      bounded(bound, async () => {
        const described = await client.workflow.getHandle(call.workflowId).describe();
        return { running: described.status.name === "RUNNING" };
      }),
  };
}

/**
 * Close every connection `sdkEngine` holds. For a script or a suite that must end; the web tier keeps its own.
 *
 * It waits for the SDK's calls to settle first. A call this client gave up on at its deadline is still the SDK's
 * for a moment longer: its retry is on a timer, and a timer that fires on a closed connection throws where nothing
 * can catch it. After the deadline that retry sends nothing (the bound is past) and is the last.
 */
export async function closeWorkflowsEngines(): Promise<void> {
  const engines = [...(holder.hbWorkflowsEngines?.values() ?? [])];
  holder.hbWorkflowsEngines?.clear();
  await Promise.all(
    engines.map(async ({ connection, inFlight }) => {
      await Promise.allSettled([...inFlight]);
      await connection.close();
    }),
  );
}

/* ---------------------------------------------------------------- the three calls */

/** Run one call under the deadline: refused at once without an engine, cancelled and refused at the deadline. */
async function bounded<T>(what: string, deps: WorkflowsClientDeps, run: (engine: WorkflowsEngine, bound: CallBound) => Promise<T>): Promise<T> {
  const { address, namespace } = deps;
  if (address === undefined) throw new WorkflowsUnavailableError("unconfigured", "TEMPORAL_ADDRESS is not set: the workflow engine cannot be reached (feature-specs/28 § 3).");
  if (namespace === undefined) throw new WorkflowsUnavailableError("unconfigured", "TEMPORAL_NAMESPACE is not set: every call to the workflow engine names it (feature-specs/28 § 3).");
  const controller = new AbortController();
  const late = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new WorkflowsUnavailableError("timeout", `${what}: the workflow engine did not answer within ${String(deps.deadlineMs)} ms`)), { once: true });
  });
  const timer = setTimeout(() => controller.abort(), deps.deadlineMs);
  try {
    return await Promise.race([run(deps.engine({ address, namespace }), { at: Date.now() + deps.deadlineMs, signal: controller.signal }), late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface StartedWorkflow {
  readonly workflowId: string;
  /** The run now under that id: the one this call started, or the one that was already running. */
  readonly runId: string;
}

/**
 * Start the workflow `name` under `id`, or be handed the run already there under it. The caller writes the state
 * that says "started" only after this returned (28 § 5): on an error nothing is half done on its side.
 */
export async function startWorkflow<N extends WorkflowName>(name: N, id: string, input: WorkflowInput<N>, deps: WorkflowsClientDeps = defaultWorkflowsDeps()): Promise<StartedWorkflow> {
  const definition: WorkflowDefinition = WORKFLOWS[name];
  const workflowId = definition.id.parse(id);
  const parsed: unknown = definition.input.parse(input);
  const timeout = definition.executionTimeoutMs === undefined ? {} : { executionTimeoutMs: definition.executionTimeoutMs };
  const { runId } = await bounded(`start ${name}`, deps, (engine, bound) => engine.start({ name, workflowId, taskQueue: definition.taskQueue, input: parsed, ...timeout }, bound));
  return { workflowId, runId };
}

/** Send `signal` to the workflow running under `id`. `input` is the signal's argument, or null when it carries none. */
export async function signalWorkflow<N extends WorkflowName, S extends SignalName<N>>(name: N, id: string, signal: S, input: SignalInput<N, S>, deps: WorkflowsClientDeps = defaultWorkflowsDeps()): Promise<void> {
  const definition: WorkflowDefinition = WORKFLOWS[name];
  const workflowId = definition.id.parse(id);
  if (!Object.hasOwn(definition.signals, signal)) throw new AppError("INTERNAL", `${name} takes no signal ${signal}`);
  const schema = definition.signals[signal];
  const parsed: unknown = schema === null ? null : schema.parse(input);
  await bounded(`signal ${signal} to ${name}`, deps, (engine, bound) => engine.signal({ workflowId, signal, input: parsed }, bound));
}

/**
 * Ask the run under `id` to cancel (feature-specs/32 § 8: a pending item's grading is cancelled when the item is
 * removed). The request is delivered; the workflow ends when its code sees it. A run that has already ended or was
 * never there is `WorkflowNotFoundError`, which a caller removing a row may take as done.
 */
export async function cancelWorkflow<N extends WorkflowName>(name: N, id: string, deps: WorkflowsClientDeps = defaultWorkflowsDeps()): Promise<void> {
  const definition: WorkflowDefinition = WORKFLOWS[name];
  const workflowId = definition.id.parse(id);
  await bounded(`cancel ${name}`, deps, (engine, bound) => engine.cancel({ workflowId }, bound));
}

/**
 * Whether the workflow under `id` still runs (feature-specs/45 § 3.5; unit 62f): the sweep of detached research runs
 * asks the engine rather than a row, which can say a run ended while its workflow still runs. A run closed in any way
 * does not, and neither does an id the engine no longer knows, its history past retention: `false`, not an error. An
 * engine that cannot be reached is `WorkflowsUnavailableError`, as for every call.
 */
export async function workflowRunning<N extends WorkflowName>(name: N, id: string, deps: WorkflowsClientDeps = defaultWorkflowsDeps()): Promise<boolean> {
  const definition: WorkflowDefinition = WORKFLOWS[name];
  const workflowId = definition.id.parse(id);
  try {
    return (await bounded(`describe ${name}`, deps, (engine, bound) => engine.describe({ workflowId }, bound))).running;
  } catch (error: unknown) {
    if (error instanceof WorkflowNotFoundError) return false;
    throw error;
  }
}

/** Ask the workflow under `id` its `query`. The answer is the query's schema's, or the call is an error. */
export async function queryWorkflow<N extends WorkflowName, Q extends QueryName<N>>(name: N, id: string, query: Q, deps: WorkflowsClientDeps = defaultWorkflowsDeps()): Promise<QueryAnswer<N, Q>> {
  const definition: WorkflowDefinition = WORKFLOWS[name];
  const workflowId = definition.id.parse(id);
  if (!Object.hasOwn(definition.queries, query)) throw new AppError("INTERNAL", `${name} answers no query ${query}`);
  const answer = await bounded(`query ${query} of ${name}`, deps, (engine, bound) => engine.query({ workflowId, query }, bound));
  const parsed = definition.queries[query].safeParse(answer);
  if (!parsed.success) throw new WorkflowsUnavailableError("malformed", `${name}.${query}: the answer is not the query's shape`);
  return parsed.data as QueryAnswer<N, Q>;
}
