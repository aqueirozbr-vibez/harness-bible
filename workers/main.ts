import "dotenv/config";

import { getPrisma } from "@/lib/db/client";
import { countGatewayKeys } from "@/lib/db/gateway";
import { env } from "@/lib/env";
import { defaultGatewayDeps } from "@/lib/gateway/client";
import { registerProcessSecret } from "@/lib/security/processSecrets";
import { startTelemetry, stopTelemetry } from "@/lib/telemetry/tracer";

import { engineConfigOf, listenAddressOf, requireWorkersSecrets, workersEnv, type EngineConfig, type ListenAddress } from "./env";
import { engineProbe, gatewayProbe } from "./health";
import { keyDb } from "./keys";
import { chaptersVerifiedFor } from "./answer/run";
import { runTurn } from "./answer/turn";
import type { SessionUser } from "@/lib/auth/session";
import { startWorkers } from "./server";

/*
 * npm run workers (feature-specs/11 § 7.1): the process that holds GATEWAY_KEY_SECRET and LITELLM_MASTER_KEY and
 * answers the web tier over the private surface of workers/server.ts. It listens at the host and port of
 * WORKERS_URL, the address the app dials (a URL without a port means its protocol's own, workers/env.ts
 * `listenAddressOf`), and refuses to start without that URL or the bearer WORKERS_TOKEN,
 * as the stub refuses without the master key. In production a missing GATEWAY_KEY_SECRET or LITELLM_MASTER_KEY
 * refuses the boot too (§ 8); in development the routes that need them refuse per request.
 *
 * Since unit 45b it is also the workflow engine's worker (feature-specs/28 § 4; workers/temporal.ts) when
 * TEMPORAL_ADDRESS names one: both task queues are polled beside the HTTP surface, and an engine that is not
 * there does not stop the surface from starting.
 */

function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

const url = env.WORKERS_URL ?? refuse("WORKERS_URL is not set: the workers listen at its host and port (see .env.example).");
const token = env.WORKERS_TOKEN ?? refuse("WORKERS_TOKEN is not set: every request to the workers carries it (feature-specs/11 § 7.1; see .env.example).");
const workers = workersEnv();
requireWorkersSecrets(env.NODE_ENV === "production", { keySecret: env.GATEWAY_KEY_SECRET, masterKey: workers.masterKey });

function listenAddress(value: string): ListenAddress {
  try {
    return listenAddressOf(value);
  } catch (error: unknown) {
    refuse(error instanceof Error ? error.message : String(error));
  }
}

const listen = listenAddress(url);

function engineConfig(): EngineConfig | null {
  try {
    return engineConfigOf({ address: env.TEMPORAL_ADDRESS, namespace: env.TEMPORAL_NAMESPACE });
  } catch (error: unknown) {
    refuse(error instanceof Error ? error.message : String(error));
  }
}

const engine = engineConfig();
/* On demand, never at the top of the file: without an engine the SDK and its native module are not loaded at all. */
const temporal = () => import("./temporal");
/* The gateway's master key is read by the workers alone, so the guard on lines and spans is told of it here (feature-specs/21 § 6.1). */
registerProcessSecret(workers.masterKey);
/* Spans to the collector when one is configured (feature-specs/21 § 5.1, D3); the lines are written either way. */
void startTelemetry("hb-workers").then((exporting) => {
  if (exporting) console.info("telemetry: the workers export their spans");
});
startWorkers({
  token,
  keys: { gatewayUrl: env.GATEWAY_URL, masterKey: workers.masterKey, keySecret: env.GATEWAY_KEY_SECRET, individual: workers.individual, fetch: globalThis.fetch, now: () => new Date(), db: keyDb },
  gateway: defaultGatewayDeps(),
  probe: gatewayProbe({ gatewayUrl: env.GATEWAY_URL, fetch: globalThis.fetch, now: () => new Date() }),
  engine: engineProbe({ check: engine === null ? undefined : async (deadlineMs) => (await temporal()).checkEngine(engine, deadlineMs), now: () => new Date() }),
  keyCount: countGatewayKeys,
  answer: async (body, emit, traceId) => {
    await runTurn(
      {
        conversationId: body.conversationId,
        /* The reader as a turn needs them: whose rows, and in which language. The web tier sends neither their
           verification nor a curator's parts, because an answer depends on neither; they are stated as the least
           they could be, so that nothing built from this user is ever allowed more than the reader is. */
        user: { id: body.user.id, organisationId: body.user.organisationId, role: body.user.role as SessionUser["role"], displayName: body.user.displayName, locale: body.user.locale, identityVerified: false, parts: [], sessionId: null },
        principal: body.principal,
        text: body.text,
        mode: body.mode,
        context: body.context,
        aid: body.aid,
        traceId,
      },
      (event) => {
        emit(event);
      },
      {
        gateway: defaultGatewayDeps(),
        /* A chapter the release has not verified is refused before anything is spent (spec 13 § 4.1). */
        chaptersVerified: chaptersVerifiedFor,
        /* The walk's script runs in the lab tier's container; `AID_RUNNER=python` only where there is no Docker (spec 18 § 4). */
        aid: { runner: env.AID_RUNNER, python: env.PYTHON_BIN, docker: env.DOCKER_BIN, image: env.AID_IMAGE },
      },
    );
  },
  host: listen.host,
  port: listen.port,
})
  .then(async (running) => {
    console.log(`workers listening on ${running.url} (gateway ${env.GATEWAY_URL ?? "unset: every model call refuses"})`);
    if (engine === null) console.log("workflows: TEMPORAL_ADDRESS is unset, so no workflow runs (feature-specs/28 § 7)");
    const workflows = engine === null ? null : (await temporal()).superviseEngine(engine);
    const stop = (): void => {
      void running
        .close()
        .then(() => workflows?.stop())
        .then(() => stopTelemetry())
        .then(() => getPrisma().$disconnect())
        .then(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  })
  .catch((error: unknown) => {
    refuse(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  });
