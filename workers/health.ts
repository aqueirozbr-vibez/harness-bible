import type { EngineState, GatewayState } from "@/lib/schemas/workers";

/*
 * The gateway's state on `/health` (feature-specs/11 § 7.2): a probe of the gateway's `/health/liveliness`
 * (LiteLLM's route, which the stub answers too), cached and refreshed every 30 s, never a model call. No
 * `GATEWAY_URL` is `down`, as every model call would be refused (§ 8).
 *
 * The probe's deadline is **strictly inside** the `/health` route's own deadline, which is Andre's 5 s of
 * 2026-09-24 (`ROUTE_TIMEOUT_MS` in `lib/workers/client.ts`). Unit 37a set both to 5 s and called that
 * deliberate; it is a race the client always wins: the handler awaits the probe, so on a cold or stale cache a
 * gateway that accepts the connection and never answers made the workers answer at ~5.0 s and the client's own
 * 5.000 s signal fire first, turning the one outage `/health` exists to report into `WorkersUnavailableError`.
 * The 3 s is the implementer's number, not a second number of Andre's: it is his 5 s less a margin for the
 * abort's delivery, the handler's `Promise.all` with the key count, the JSON and the hop back. The workers
 * cannot import the route table — `lib/workers/` is the web tier's side of the channel — so the relation is
 * asserted in `workers/server.test.ts` instead of restated in a comment. A gateway that has not answered in
 * 3 s reads as `down` and the cache keeps refreshing, rather than holding a promise that never settles.
 */

export const PROBE_REFRESH_MS = 30_000;
export const PROBE_DEADLINE_MS = 3_000;
export const LIVELINESS_PATH = "/health/liveliness";

export interface ProbeDeps {
  readonly gatewayUrl: string | undefined;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  /** The probe's deadline; `PROBE_DEADLINE_MS` unless a caller shortens it (the tests do). */
  readonly deadlineMs?: number;
}

/** One probe: `up` on a 200, `down` on any other status, a connection failure, a deadline passed or no gateway configured. */
export async function probeGateway(deps: ProbeDeps): Promise<GatewayState> {
  if (deps.gatewayUrl === undefined) return "down";
  try {
    const response = await deps.fetch(`${deps.gatewayUrl}${LIVELINESS_PATH}`, { method: "GET", signal: AbortSignal.timeout(deps.deadlineMs ?? PROBE_DEADLINE_MS) });
    await response.arrayBuffer();
    return response.status === 200 ? "up" : "down";
  } catch {
    return "down";
  }
}

/** A probe behind a cache: the last state while it is younger than 30 s, one probe in flight at a time otherwise. */
function cachedProbe<State>(probe: () => Promise<State>, now: () => Date): () => Promise<State> {
  let cached: { readonly state: State; readonly at: number } | null = null;
  let inFlight: Promise<State> | null = null;
  return () => {
    const at = now().getTime();
    if (cached !== null && at - cached.at < PROBE_REFRESH_MS) return Promise.resolve(cached.state);
    if (inFlight === null) {
      inFlight = probe()
        .then((state) => {
          cached = { state, at: now().getTime() };
          return state;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}

/** The cached probe of the gateway. */
export function gatewayProbe(deps: ProbeDeps): () => Promise<GatewayState> {
  return cachedProbe(() => probeGateway(deps), deps.now);
}

/*
 * The workflow engine's state on `/health` (feature-specs/28 § 4.5), probed as the gateway is: cached, refreshed
 * every 30 s, and deadlined strictly inside the route's own deadline for the reason given above. `off` is not a
 * failure: without TEMPORAL_ADDRESS the workers run no engine worker and nothing that needs a workflow is offered.
 */
export interface EngineProbeDeps {
  /** Asks the engine whether it answers and knows the namespace; rejects when it does not, or not in time. Undefined = no engine configured. */
  readonly check: ((deadlineMs: number) => Promise<void>) | undefined;
  readonly now: () => Date;
  readonly deadlineMs?: number;
}

/**
 * One probe: `off` without an engine, `up` when the check resolves, `down` when it rejects or the deadline passes.
 * The deadline is enforced here as well as handed to the check, so a check that ignores it cannot hold `/health`.
 */
export async function probeEngine(deps: EngineProbeDeps): Promise<EngineState> {
  if (deps.check === undefined) return "off";
  const deadlineMs = deps.deadlineMs ?? PROBE_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("deadline"));
      }, deadlineMs);
    });
    await Promise.race([deps.check(deadlineMs), late]);
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

/** The cached probe of the engine. */
export function engineProbe(deps: EngineProbeDeps): () => Promise<EngineState> {
  return cachedProbe(() => probeEngine(deps), deps.now);
}
