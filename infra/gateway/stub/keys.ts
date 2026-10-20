import { randomBytes } from "node:crypto";

import { z } from "zod";

import { sha256Hex } from "./answer";

/*
 * The stub gateway's in-memory key table (feature-specs/11 § 4): `/key/generate`, `/key/info`, `/key/delete` in
 * LiteLLM's shapes, and the spend counter behind the budget refusal. A key minted with `max_budget` and
 * `budget_duration: "1mo"` resets its spend on the first of the next month, as the proxy does (25a saw
 * `budget_reset_at: 2026-10-01T00:00:00+00:00`). Pure functions over a table the server owns.
 */

/** What the workers send to `/key/generate` (spec § 3.4); the stub reads these fields and echoes the rest. */
export const GenerateKeySchema = z.looseObject({
  max_budget: z.number().nonnegative().nullable().optional(),
  budget_duration: z.literal("1mo").nullable().optional(),
  tpm_limit: z.number().int().positive().nullable().optional(),
  models: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  key_alias: z.string().min(1).nullable().optional(),
});
export type GenerateKeyInput = z.infer<typeof GenerateKeySchema>;

/** LiteLLM's `KeyRequest`: the keys to delete, plain or hashed. */
export const DeleteKeysSchema = z.looseObject({ keys: z.array(z.string().min(1)).min(1) });

export interface KeyRecord {
  readonly key: string;
  /** sha256 of the key: LiteLLM's `token`, what `/key/info` and `/key/delete` also accept. */
  readonly token: string;
  readonly keyAlias: string | null;
  readonly maxBudget: number | null;
  readonly budgetDuration: "1mo" | null;
  readonly budgetResetAt: Date | null;
  readonly tpmLimit: number | null;
  readonly models: ReadonlyArray<string>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly spend: number;
  readonly createdAt: Date;
}

export type KeyTable = Map<string, KeyRecord>;

/** The first of the month after `now`, 00:00 UTC. */
export function firstOfNextMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** LiteLLM's display form of a key: `sk-...` and the last four characters. */
export function keyName(key: string): string {
  return `sk-...${key.slice(-4)}`;
}

export function mintKey(table: KeyTable, input: GenerateKeyInput, now: Date): KeyRecord {
  const key = `sk-${randomBytes(16).toString("hex")}`;
  const budgetDuration = input.budget_duration ?? null;
  const record: KeyRecord = {
    key,
    token: sha256Hex(key),
    keyAlias: input.key_alias ?? null,
    maxBudget: input.max_budget ?? null,
    budgetDuration,
    budgetResetAt: budgetDuration === "1mo" ? firstOfNextMonth(now) : null,
    tpmLimit: input.tpm_limit ?? null,
    models: input.models ?? [],
    metadata: input.metadata ?? {},
    spend: 0,
    createdAt: now,
  };
  table.set(record.token, record);
  return record;
}

/** Looks a key up by its plain value or its hash, rolling its budget window forward when it has passed. */
export function findKey(table: KeyTable, keyOrToken: string, now: Date): KeyRecord | null {
  const record = table.get(keyOrToken) ?? table.get(sha256Hex(keyOrToken)) ?? null;
  if (record === null) return null;
  if (record.budgetResetAt !== null && now >= record.budgetResetAt) {
    const rolled: KeyRecord = { ...record, spend: 0, budgetResetAt: firstOfNextMonth(now) };
    table.set(record.token, rolled);
    return rolled;
  }
  return record;
}

export function deleteKeys(table: KeyTable, keysOrTokens: ReadonlyArray<string>): ReadonlyArray<string> {
  const deleted: string[] = [];
  for (const value of keysOrTokens) {
    const record = table.get(value) ?? table.get(sha256Hex(value));
    if (record === undefined) continue;
    table.delete(record.token);
    deleted.push(value);
  }
  return deleted;
}

/** LiteLLM's pre-call check: refused once the spend has reached the budget (`spend >= max_budget`). */
export function budgetExceeded(record: KeyRecord): boolean {
  return record.maxBudget !== null && record.spend >= record.maxBudget;
}

/** The proxy's message for the refusal (auth_checks.py at the pinned image), what `isBudgetError` matches on. */
export function budgetMessage(record: KeyRecord): string {
  const label = record.keyAlias ?? "key";
  return `Budget has been exceeded! Key=${label} (${keyName(record.key)}) Current cost: ${record.spend}, Max budget: ${record.maxBudget}`;
}

export function charge(table: KeyTable, record: KeyRecord, costUsd: number): KeyRecord {
  const charged: KeyRecord = { ...record, spend: record.spend + costUsd };
  table.set(record.token, charged);
  return charged;
}

/** The public form of a key record: `/key/generate` returns it with the key, `/key/info` without. */
export function keyInfo(record: KeyRecord, withKey: boolean): Readonly<Record<string, unknown>> {
  return {
    ...(withKey ? { key: record.key } : {}),
    token: record.token,
    key_name: keyName(record.key),
    key_alias: record.keyAlias,
    spend: record.spend,
    max_budget: record.maxBudget,
    budget_duration: record.budgetDuration,
    budget_reset_at: record.budgetResetAt === null ? null : record.budgetResetAt.toISOString(),
    tpm_limit: record.tpmLimit,
    rpm_limit: null,
    models: record.models,
    metadata: record.metadata,
    expires: null,
    created_at: record.createdAt.toISOString(),
  };
}
