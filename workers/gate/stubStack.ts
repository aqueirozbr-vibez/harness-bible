import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { UNCITED_CLAIM, type StubClaim } from "@/infra/gateway/stub/answer";
import { aliasesFromConfig, startStub } from "@/infra/gateway/stub/server";
import type { BudgetRowInput } from "@/lib/db/budget";
import { env } from "@/lib/env";
import type { GatewayDeps } from "@/lib/gateway/client";
import { encryptKey } from "@/lib/gateway/keys";
import { chaptersVerifiedFor } from "@/workers/answer/run";
import type { AidTurnOptions } from "@/workers/aids/run";
import { runTurn } from "@/workers/answer/turn";
import { gatewayProbe } from "@/workers/health";
import { startWorkers } from "@/workers/server";

/*
 * The workers over the stub gateway, in the caller's own process (feature-specs/22 § 4, the stub grade): the same
 * server, the same turn and the same flow as `npm run workers`, with the stub in the provider's place. The gate's
 * stub run uses it so that it depends on nothing that is running: no workers process, no gateway container, no key.
 * The database is the real one; the turns write their rows as any turn does. Since unit 75 a turn hands nothing to
 * research (feature-specs/48 § 9.2), so the stack has no research to switch off: until then it carried the hand-over's
 * dependencies, off unless the researcher's gate gave its own (unit 61b).
 *
 * What it measures is the plumbing, not the judgement. The stub cannot classify a question, so the caller may say
 * which cause a turn's classifier call should answer (`expectCause`), the switch the stub has for exactly that; and
 * its calls are kept here in memory instead of in BudgetLedger, where rows could never be removed again.
 */

export interface StubStack {
  /** Where the workers listen, and the bearer they expect: what `workersStream` needs. */
  readonly url: string;
  readonly token: string;
  /** The gateway calls a turn made, in order, as the rows they would have been. */
  readonly calls: (traceId: string) => ReadonlyArray<BudgetRowInput>;
  /** The cause the stub's classifier answers for this turn. */
  readonly expectCause: (traceId: string, cause: string) => void;
  /** The extra claim the stub's draft carries for this turn: `uncited`, one its section does not support. */
  readonly expectClaim: (traceId: string, claim: StubClaim) => void;
  /** That claim's text, for whoever looks for it in a stream. */
  readonly uncitedClaim: string;
  readonly close: () => Promise<void>;
}

const CAUSE_HEADER = "x-hb-stub-cause";
const CLAIM_HEADER = "x-hb-stub-claim";

export interface StubStackOptions {
  /**
   * How a walk's script is run. The environment's by default (`AID_RUNNER`: the lab tier's container), which is what
   * the gate measures; a suite that measures the turn around the run names the local interpreter instead.
   */
  readonly aid?: AidTurnOptions;
}

export async function startStubStack(options: StubStackOptions = {}): Promise<StubStack> {
  const aid: AidTurnOptions = options.aid ?? { runner: env.AID_RUNNER, python: env.PYTHON_BIN, docker: env.DOCKER_BIN, image: env.AID_IMAGE };
  /* Made for this run and gone with it: the stub's master key, the cipher's secret, the workers' bearer. */
  const masterKey = randomBytes(24).toString("hex");
  const keySecret = randomBytes(32).toString("hex");
  const token = randomBytes(24).toString("hex");
  const aliases = aliasesFromConfig(readFileSync(join(process.cwd(), "infra", "gateway", "litellm.yaml"), "utf8"));

  const stub = await startStub({ masterKey, aliases, port: 0, log: () => undefined });
  const minted = await fetch(`${stub.url}/key/generate`, {
    method: "POST",
    headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" },
    /* The stub keeps a budget as the gateway does; this one is large enough never to be the thing a run measures. */
    body: JSON.stringify({ models: [...aliases.keys()], max_budget: 1_000_000 }),
  });
  const key = ((await minted.json()) as { key: string }).key;

  const rows: BudgetRowInput[] = [];
  const causes = new Map<string, string>();
  const claims = new Map<string, StubClaim>();

  function gatewayFor(traceId: string): GatewayDeps {
    return {
      baseUrl: stub.url,
      keySecret,
      findKey: async () => ({ keyCiphertext: encryptKey(keySecret, key) }),
      append: async (row) => {
        rows.push(row);
      },
      log: () => undefined,
      fetch: async (input, init) => {
        const cause = causes.get(traceId);
        const claim = claims.get(traceId);
        if (cause === undefined && claim === undefined) return globalThis.fetch(input, init);
        const headers = new Headers(init?.headers);
        if (cause !== undefined) headers.set(CAUSE_HEADER, cause);
        if (claim !== undefined) headers.set(CLAIM_HEADER, claim);
        return globalThis.fetch(input, { ...init, headers });
      },
      now: () => new Date(),
    };
  }

  const refused = (): never => {
    throw new Error("the key routes are not part of a gate run");
  };
  const workers = await startWorkers({
    token,
    keys: {
      gatewayUrl: stub.url,
      masterKey,
      keySecret,
      individual: null,
      fetch: globalThis.fetch,
      now: () => new Date(),
      db: { findKey: async () => null, insertKey: refused, replaceKey: refused, organisationCaps: async () => null, isIndividualUser: async () => false },
    },
    gateway: gatewayFor(""),
    probe: gatewayProbe({ gatewayUrl: stub.url, fetch: globalThis.fetch, now: () => new Date() }),
    keyCount: async () => 1,
    answer: async (body, emit, traceId) =>
      runTurn(
        {
          conversationId: body.conversationId,
          user: { id: body.user.id, organisationId: body.user.organisationId, role: "READER", displayName: body.user.displayName, locale: body.user.locale, identityVerified: false, parts: [], sessionId: null },
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
        { gateway: gatewayFor(traceId), chaptersVerified: chaptersVerifiedFor, aid },
      ),
    host: "127.0.0.1",
    port: 0,
    log: () => undefined,
  });

  return {
    url: workers.url,
    token,
    calls: (traceId) => rows.filter((row) => row.traceId === traceId),
    expectCause: (traceId, cause) => {
      causes.set(traceId, cause);
    },
    expectClaim: (traceId, claim) => {
      claims.set(traceId, claim);
    },
    uncitedClaim: UNCITED_CLAIM,
    close: async () => {
      await workers.close();
      await stub.close();
    },
  };
}
