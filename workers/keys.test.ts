import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { aliasesFromConfig, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import type { GatewayKeyData, GatewayKeyRow, OrganisationCaps } from "@/lib/db/gateway";
import { GatewayUnavailableError } from "@/lib/gateway/errors";
import { decryptKey } from "@/lib/gateway/keys";
import type { Principal } from "@/lib/schemas/gateway";
import { ensureKey, generateKeyBody, rotateKey, type KeyDb, type KeyDeps } from "@/workers/keys";

/*
 * The workers mint and rotate keys through the stub's management routes (feature-specs/11 § 3.4, § 7.2), with
 * the GatewayKey rows as an in-memory table. The database-backed path is tests/integration/gateway.test.ts.
 */

const MASTER_KEY = "test-master-key-for-the-workers";
const SECRET = "0123456789abcdef".repeat(4);
const NOW = new Date("2026-09-23T12:00:00.000Z");
const ALIASES = aliasesFromConfig(readFileSync(join(import.meta.dirname, "..", "infra", "gateway", "litellm.yaml"), "utf8"));
const ORG: Principal = { organisationId: "org-1" };
const USER: Principal = { userId: "u-1" };
const ORG_CAPS: OrganisationCaps = { tokenCap: BigInt(1_000_000), tokensPerMinute: 1000 };
const INDIVIDUAL = { tokenCap: BigInt(200_000), tokensPerMinute: 100 };

/** The GatewayKey table as a map, with the two guards the migration gives it: one row per principal (the unique index, raised as Prisma's P2002) and a replacement that must name the key it replaces. */
function memoryDb(): KeyDb & { readonly rows: Map<string, GatewayKeyRow> } {
  const rows = new Map<string, GatewayKeyRow>();
  const keyOf = (principal: Principal): string => JSON.stringify(principal);
  return {
    rows,
    findKey: async (principal) => rows.get(keyOf(principal)) ?? null,
    insertKey: async (principal, data: GatewayKeyData) => {
      if (rows.has(keyOf(principal))) throw Object.assign(new Error("Unique constraint failed on the fields: (`organisationId`)"), { code: "P2002" });
      const row: GatewayKeyRow = { id: `row-${rows.size + 1}`, ...data, maxBudgetUsd: String(data.maxBudgetUsd), createdAt: NOW, rotatedAt: null };
      rows.set(keyOf(principal), row);
      return row;
    },
    replaceKey: async (principal, data, rotatedAt, replacing) => {
      const existing = rows.get(keyOf(principal));
      if (existing === undefined || existing.litellmKeyId !== replacing) return null;
      const row: GatewayKeyRow = { ...existing, ...data, maxBudgetUsd: String(data.maxBudgetUsd), rotatedAt };
      rows.set(keyOf(principal), row);
      return row;
    },
    organisationCaps: async (id) => (id === "org-1" ? ORG_CAPS : null),
    isIndividualUser: async (id) => id === "u-1",
  };
}

describe("generateKeyBody", () => {
  it("asks for the spec's key: max_budget from the cap (D3), 1mo, tpm_limit, the four aliases, the principal in metadata", () => {
    expect(generateKeyBody(ORG, ORG_CAPS)).toEqual({
      max_budget: 5,
      budget_duration: "1mo",
      tpm_limit: 1000,
      models: ["hb-frontier", "hb-small", "hb-embed", "hb-rerank"],
      metadata: { organisationId: "org-1", kind: "organisation" },
      key_alias: "org:org-1",
    });
    expect(generateKeyBody(USER, INDIVIDUAL)).toMatchObject({ max_budget: 1, tpm_limit: 100, metadata: { userId: "u-1", kind: "individual" }, key_alias: "user:u-1" });
  });
});

describe("the workers' keys against the stub", () => {
  let stub: RunningStub;
  const lines: string[] = [];

  beforeAll(async () => {
    stub = await startStub({ masterKey: MASTER_KEY, aliases: ALIASES, port: 0, log: (line) => lines.push(line), now: () => NOW });
  });
  afterAll(async () => {
    await stub.close();
  });

  function deps(overrides: Partial<Omit<KeyDeps, "db">> = {}): KeyDeps & { readonly db: ReturnType<typeof memoryDb> } {
    return { gatewayUrl: stub.url, masterKey: MASTER_KEY, keySecret: SECRET, individual: null, fetch: globalThis.fetch, now: () => NOW, db: memoryDb(), ...overrides };
  }

  async function info(token: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${stub.url}/key/info?key=${token}`, { headers: { authorization: `Bearer ${MASTER_KEY}` } });
    return res.status === 200 ? ((await res.json()) as { info: Record<string, unknown> }).info : { status: res.status };
  }

  async function usable(key: string): Promise<number> {
    const res = await fetch(`${stub.url}/v1/messages`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ model: "hb-small", max_tokens: 64, messages: [{ role: "user", content: "gateway check" }] }) });
    return res.status;
  }

  it("mints an organisation's key with its caps, stores it encrypted, and returns the same id on the second ensure", async () => {
    const d = deps();
    const minted = await ensureKey(ORG, d);
    expect(minted.rotatedAt).toBeNull();
    const row = d.db.rows.get(JSON.stringify(ORG));
    expect(row?.litellmKeyId).toBe(minted.litellmKeyId);
    expect(row?.maxBudgetUsd).toBe("5");
    expect(row?.tokensPerMinute).toBe(1000);
    const key = decryptKey(SECRET, row?.keyCiphertext ?? "");
    expect(key).toMatch(/^sk-[0-9a-f]{32}$/);
    expect(row?.keyCiphertext).not.toContain(key);
    expect(await info(minted.litellmKeyId)).toMatchObject({ max_budget: 5, budget_duration: "1mo", tpm_limit: 1000, models: ["hb-frontier", "hb-small", "hb-embed", "hb-rerank"], metadata: { organisationId: "org-1", kind: "organisation" }, key_alias: "org:org-1" });
    expect(await usable(key)).toBe(200);
    const again = await ensureKey(ORG, d);
    expect(again.litellmKeyId).toBe(minted.litellmKeyId);
    expect(lines.filter((line) => line.startsWith("POST /key/generate"))).toHaveLength(1);
  });

  it("rotates: a new id, rotatedAt set, the old key refused by the gateway, the new one usable", async () => {
    const d = deps();
    const first = await ensureKey(ORG, d);
    const oldKey = decryptKey(SECRET, d.db.rows.get(JSON.stringify(ORG))?.keyCiphertext ?? "");
    const rotated = await rotateKey(ORG, d);
    expect(rotated.litellmKeyId).not.toBe(first.litellmKeyId);
    expect(rotated.rotatedAt?.toISOString()).toBe(NOW.toISOString());
    expect(await info(first.litellmKeyId)).toEqual({ status: 404 });
    expect(await usable(oldKey)).toBe(401);
    expect(await usable(decryptKey(SECRET, d.db.rows.get(JSON.stringify(ORG))?.keyCiphertext ?? ""))).toBe(200);
    const twice = await rotateKey(ORG, d);
    expect(twice.litellmKeyId).not.toBe(rotated.litellmKeyId);
  });

  it("mints when asked to rotate a principal that has no key yet", async () => {
    const d = deps();
    const minted = await rotateKey(ORG, d);
    expect(minted.rotatedAt).toBeNull();
    expect(d.db.rows.size).toBe(1);
  });

  it("mints an individual account's key with the fixed caps, and refuses while they are unset (D5)", async () => {
    const withCaps = deps({ individual: INDIVIDUAL });
    const minted = await ensureKey(USER, withCaps);
    expect(await info(minted.litellmKeyId)).toMatchObject({ max_budget: 1, tpm_limit: 100, metadata: { userId: "u-1", kind: "individual" } });
    const generated = lines.filter((line) => line.startsWith("POST /key/generate")).length;
    await expect(ensureKey(USER, deps())).rejects.toMatchObject({ code: "GATEWAY_INDIVIDUAL_CAP_UNSET" });
    expect(lines.filter((line) => line.startsWith("POST /key/generate"))).toHaveLength(generated);
  });

  function count(prefix: string): number {
    return lines.filter((line) => line.startsWith(prefix)).length;
  }

  it("mints once for the principal under concurrent ensure calls: one row, one live key, the spares revoked", async () => {
    const d = deps();
    const generated = count("POST /key/generate");
    const deleted = count("POST /key/delete");
    const results = await Promise.all([ensureKey(ORG, d), ensureKey(ORG, d), ensureKey(ORG, d)]);
    const ids = new Set(results.map((result) => result.litellmKeyId));
    expect(ids.size).toBe(1);
    expect(d.db.rows.size).toBe(1);
    const row = d.db.rows.get(JSON.stringify(ORG));
    expect([...ids][0]).toBe(row?.litellmKeyId);
    expect(count("POST /key/generate") - generated).toBe(3);
    expect(count("POST /key/delete") - deleted).toBe(2);
    expect(await info(row?.litellmKeyId ?? "")).toMatchObject({ max_budget: 5, key_alias: "org:org-1" });
    expect(await usable(decryptKey(SECRET, row?.keyCiphertext ?? ""))).toBe(200);
  });

  it("keeps the winner's key when two rotations race, and revokes the one it minted for nothing", async () => {
    const d = deps();
    const first = await ensureKey(ORG, d);
    const [a, b] = await Promise.all([rotateKey(ORG, d), rotateKey(ORG, d)]);
    expect(a.litellmKeyId).toBe(b.litellmKeyId);
    expect(a.litellmKeyId).not.toBe(first.litellmKeyId);
    const row = d.db.rows.get(JSON.stringify(ORG));
    expect(row?.litellmKeyId).toBe(a.litellmKeyId);
    expect(await info(first.litellmKeyId)).toEqual({ status: 404 });
    expect(await usable(decryptKey(SECRET, row?.keyCiphertext ?? ""))).toBe(200);
  });

  it("refuses with GATEWAY_KEYS_UNAVAILABLE when the row that won the race is gone again, and mints no second key for it", async () => {
    const d = deps();
    const taken: KeyDb = { ...d.db, insertKey: () => Promise.reject(Object.assign(new Error("Unique constraint failed on the fields: (`organisationId`)"), { code: "P2002" })) };
    const generated = count("POST /key/generate");
    await expect(ensureKey(ORG, { ...d, db: taken })).rejects.toMatchObject({ code: "GATEWAY_KEYS_UNAVAILABLE" });
    expect(count("POST /key/generate") - generated).toBe(1);
    expect(count("POST /key/delete")).toBeGreaterThan(0);
  });

  it("replaces the row before deleting the old key, so a refused delete leaves the new key in place and names the old one for cleanup", async () => {
    const d = deps();
    const first = await ensureKey(ORG, d);
    const refuseDelete: typeof fetch = (input, init) => (String(input).endsWith("/key/delete") ? Promise.reject(new Error("the delete never left")) : globalThis.fetch(input, init));
    const said: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      said.push(String(line));
    });
    try {
      const rotated = await rotateKey(ORG, { ...d, fetch: refuseDelete });
      expect(rotated.litellmKeyId).not.toBe(first.litellmKeyId);
      expect(d.db.rows.get(JSON.stringify(ORG))?.litellmKeyId).toBe(rotated.litellmKeyId);
      expect(await usable(decryptKey(SECRET, d.db.rows.get(JSON.stringify(ORG))?.keyCiphertext ?? ""))).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(said.join(" | ")).toContain(first.litellmKeyId);
    expect(said.join(" | ")).not.toContain("sk-");
    expect(await info(first.litellmKeyId)).toMatchObject({ max_budget: 5 });
  });

  it("refuses an unknown principal before minting", async () => {
    await expect(ensureKey({ organisationId: "org-9" }, deps())).rejects.toMatchObject({ code: "PRINCIPAL_UNKNOWN" });
    await expect(ensureKey({ userId: "u-9" }, deps({ individual: INDIVIDUAL }))).rejects.toMatchObject({ code: "PRINCIPAL_UNKNOWN" });
  });

  it("refuses to mint a key it could not store: no secret, no gateway, no master key", async () => {
    const generated = lines.filter((line) => line.startsWith("POST /key/generate")).length;
    await expect(ensureKey(ORG, deps({ keySecret: undefined }))).rejects.toMatchObject({ code: "GATEWAY_KEYS_UNAVAILABLE" });
    await expect(ensureKey(ORG, deps({ gatewayUrl: undefined }))).rejects.toMatchObject({ code: "GATEWAY_UNAVAILABLE", cause: "unconfigured" });
    await expect(ensureKey(ORG, deps({ masterKey: undefined }))).rejects.toMatchObject({ code: "GATEWAY_UNAVAILABLE", cause: "unconfigured" });
    expect(lines.filter((line) => line.startsWith("POST /key/generate"))).toHaveLength(generated);
  });

  it("reports a wrong master key and an unreachable gateway as the gateway's unavailability, never a silent skip", async () => {
    const wrong = await ensureKey(ORG, deps({ masterKey: "sk-not-the-master" })).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(GatewayUnavailableError);
    expect((wrong as GatewayUnavailableError).cause).toBe("key_management");
    expect((wrong as GatewayUnavailableError).message).toContain("/key/generate answered 401");
    const down = await ensureKey(ORG, deps({ gatewayUrl: "http://127.0.0.1:1" })).catch((e: unknown) => e);
    expect((down as GatewayUnavailableError).cause).toBe("connection");
  });
});
