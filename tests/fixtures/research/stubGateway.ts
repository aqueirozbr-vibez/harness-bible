import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { aliasesFromConfig, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import type { BudgetRowInput } from "@/lib/db/budget";
import type { GatewayDeps } from "@/lib/gateway/client";
import { encryptKey } from "@/lib/gateway/keys";

/*
 * The stub gateway in this process for the researcher's agents (feature-specs/48 § 26, unit 69; the pattern of
 * workers/agents/researcher/planner.test.ts): a key minted at it, the rows the client would append to the budget
 * ledger kept here instead, each request's body as it was sent, and every line the stub logged, which is how a test
 * reads the searches and fetches it ran. Nothing here reads a database, so the agents' suites run without one.
 */

export interface StubGateway {
  readonly url: string;
  readonly rows: BudgetRowInput[];
  /** Each request's body as sent, in order. */
  readonly bodies: string[];
  /** What the stub said of each request: `stub research: search "…"`, `stub research: fetch …`. */
  readonly log: string[];
  /** A key minted at the stub with this budget, in US$: one a call can spend past, for the cap's tests. */
  readonly mint: (maxBudget: number) => Promise<string>;
  /** The client's dependencies on the stub with these headers added to every request, under the suite's key or `key`. */
  readonly gateway: (headers?: Readonly<Record<string, string>>, overrides?: Partial<GatewayDeps> & { readonly key?: string }) => GatewayDeps;
  readonly close: () => Promise<void>;
}

/** Every suite's clock: the day unit 69 was built. */
export const STUB_NOW = new Date("2026-10-12T12:00:00Z");

export async function startStubGateway(): Promise<StubGateway> {
  const masterKey = randomBytes(24).toString("hex");
  const keySecret = randomBytes(32).toString("hex");
  const log: string[] = [];
  const aliases = aliasesFromConfig(readFileSync(join(process.cwd(), "infra", "gateway", "litellm.yaml"), "utf8"));
  const stub: RunningStub = await startStub({ masterKey, aliases, port: 0, log: (line) => log.push(line), now: () => STUB_NOW });
  const mint = async (maxBudget: number): Promise<string> => {
    const minted = await fetch(`${stub.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" }, body: JSON.stringify({ models: [...aliases.keys()], max_budget: maxBudget }) });
    return ((await minted.json()) as { key: string }).key;
  };
  const key = await mint(1_000);
  const rows: BudgetRowInput[] = [];
  const bodies: string[] = [];
  const gateway: StubGateway["gateway"] = (headers = {}, overrides = {}) => {
    const { key: withKey = key, ...rest } = overrides;
    return {
      baseUrl: stub.url,
      keySecret,
      findKey: async () => ({ keyCiphertext: encryptKey(keySecret, withKey) }),
      append: async (row) => {
        rows.push(row);
      },
      log: () => undefined,
      fetch: async (input, init) => {
        const merged = new Headers(init?.headers);
        for (const [name, value] of Object.entries(headers)) merged.set(name, value);
        if (typeof init?.body === "string") bodies.push(init.body);
        return globalThis.fetch(input, { ...init, headers: merged });
      },
      now: () => STUB_NOW,
      ...rest,
    };
  };
  return { url: stub.url, rows, bodies, log, mint, gateway, close: () => stub.close() };
}
