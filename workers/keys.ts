import { z } from "zod";

import { findGatewayKey, insertGatewayKey, isIndividualUser, organisationCaps, replaceGatewayKey, type GatewayKeyData, type GatewayKeyRow, type OrganisationCaps } from "@/lib/db/gateway";
import type { MessageTextGate } from "@/lib/env";
import { AppError, isUniqueViolation } from "@/lib/errors";
import { GatewayUnavailableError } from "@/lib/gateway/errors";
import { encryptKey, keySecret } from "@/lib/gateway/keys";
import { MESSAGE_TEXT_OFF } from "@/lib/gateway/messageText";
import { maxBudgetUsd } from "@/lib/gateway/prices";
import { ALIASES, principalId, type Principal } from "@/lib/schemas/gateway";

/*
 * Virtual keys are minted by the workers and never by the web tier (feature-specs/11 § 3.4, § 3.6, § 7.2): one per
 * organisation with `max_budget` from its token cap (D3), `budget_duration: "1mo"`, `tpm_limit` from its
 * `tokensPerMinute` (D4), the four aliases and the principal in `metadata`; one per user for an individual
 * account with the fixed small cap (D5). The key is stored encrypted at once; a key that could not be stored
 * is never printed. Rotation mints a new key, replaces the row, then deletes the old key at the gateway, so a
 * failure in between leaves a live key the row still names, never stored ciphertext for a key the gateway has
 * forgotten. Neither call trusts its first read: a concurrent `ensure` or `rotate` for the same principal loses
 * on the row (the unique index, or the key the replacement names) and revokes the key it had just minted, so no
 * budgeted key is left that no row holds. Every failure at the gateway is `GatewayUnavailableError`, never a
 * silent unbudgeted call (§ 7.3).
 */

type Fetch = typeof fetch;

/** The caps of an individual account (D5): read from the workers' environment, both numbers owed by Andre. */
export interface IndividualCaps {
  readonly tokenCap: bigint;
  readonly tokensPerMinute: number;
}

export interface KeyDb {
  readonly findKey: (principal: Principal) => Promise<GatewayKeyRow | null>;
  readonly insertKey: (principal: Principal, data: GatewayKeyData) => Promise<GatewayKeyRow>;
  /** Replaces the row only while it still names `replacing`; null when a concurrent rotation got there first. */
  readonly replaceKey: (principal: Principal, data: GatewayKeyData, rotatedAt: Date, replacing: string) => Promise<GatewayKeyRow | null>;
  readonly organisationCaps: (organisationId: string) => Promise<OrganisationCaps | null>;
  readonly isIndividualUser: (userId: string) => Promise<boolean>;
}

export const keyDb: KeyDb = { findKey: findGatewayKey, insertKey: insertGatewayKey, replaceKey: replaceGatewayKey, organisationCaps, isIndividualUser };

export interface KeyDeps {
  readonly gatewayUrl: string | undefined;
  /** LITELLM_MASTER_KEY, from the workers' own environment (spec § 8). */
  readonly masterKey: string | undefined;
  readonly keySecret: string | undefined;
  /** null while D5 is undecided: an individual account then gets no key. */
  readonly individual: IndividualCaps | null;
  readonly fetch: Fetch;
  readonly now: () => Date;
  readonly db: KeyDb;
  /** The minting process's development text gate (feature-specs/49 § 9.2, D2); absent counts as off. */
  readonly messageText?: MessageTextGate;
}

export interface KeyInfo {
  readonly litellmKeyId: string;
  readonly createdAt: Date;
  readonly rotatedAt: Date | null;
}

export interface GenerateKeyBody {
  readonly max_budget: number;
  readonly budget_duration: "1mo";
  readonly tpm_limit: number;
  readonly models: ReadonlyArray<string>;
  readonly metadata: ({ readonly organisationId: string; readonly kind: "organisation" } | { readonly userId: string; readonly kind: "individual" }) & {
    /** Lets this key's requests opt out of the gateway's redaction (49 § 9.2, lock 2): set only while the gate is on. */
    readonly allow_client_message_redaction_opt_out?: true;
  };
  readonly key_alias: string;
}

/**
 * What `/key/generate` is asked for (spec § 3.4), from the principal's caps; and, only while the minting process's
 * development text gate is on, the metadata flag that lets the key's requests opt out of the gateway's redaction
 * (feature-specs/49 § 9.2, D2). A key minted with the gate off never carries it, so it stays redacted.
 */
export function generateKeyBody(principal: Principal, caps: OrganisationCaps, gate: MessageTextGate = MESSAGE_TEXT_OFF): GenerateKeyBody {
  return {
    max_budget: maxBudgetUsd(caps.tokenCap),
    budget_duration: "1mo",
    tpm_limit: caps.tokensPerMinute,
    models: [...ALIASES],
    metadata: {
      ...("organisationId" in principal ? { organisationId: principal.organisationId, kind: "organisation" as const } : { userId: principal.userId, kind: "individual" as const }),
      ...(gate.on ? { allow_client_message_redaction_opt_out: true as const } : {}),
    },
    key_alias: principalId(principal),
  };
}

/** LiteLLM's `/key/generate` answer: the key and its hash, the id the proxy's management routes take. */
const GeneratedKeySchema = z.looseObject({ key: z.string().min(1), token: z.string().min(1) });

function infoOf(row: GatewayKeyRow): KeyInfo {
  return { litellmKeyId: row.litellmKeyId, createdAt: row.createdAt, rotatedAt: row.rotatedAt };
}

async function capsOf(principal: Principal, deps: KeyDeps): Promise<OrganisationCaps> {
  if ("organisationId" in principal) {
    const caps = await deps.db.organisationCaps(principal.organisationId);
    if (caps === null) throw new AppError("PRINCIPAL_UNKNOWN", `no organisation ${principal.organisationId}`);
    return caps;
  }
  if (!(await deps.db.isIndividualUser(principal.userId))) throw new AppError("PRINCIPAL_UNKNOWN", `no individual account ${principal.userId}`);
  if (deps.individual === null) {
    throw new AppError("GATEWAY_INDIVIDUAL_CAP_UNSET", "the individual account's cap is not set (INDIVIDUAL_TOKEN_CAP and its tokens per minute; feature-specs/11 D5, blocked in the tracker): no key is minted.");
  }
  return deps.individual;
}

/** One management call under the master key; any failure is the gateway's unavailability, never a silent skip. */
async function management(deps: KeyDeps, path: "/key/generate" | "/key/delete", body: unknown, tolerated: ReadonlyArray<number> = []): Promise<unknown> {
  if (deps.gatewayUrl === undefined) throw new GatewayUnavailableError("unconfigured", "GATEWAY_URL is not set (feature-specs/11 § 8).");
  if (deps.masterKey === undefined) throw new GatewayUnavailableError("unconfigured", "LITELLM_MASTER_KEY is not set: the workers mint keys under it (feature-specs/11 § 8).");
  let response: Response;
  try {
    response = await deps.fetch(`${deps.gatewayUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${deps.masterKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error: unknown) {
    throw new GatewayUnavailableError("connection", `${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (response.status !== 200 && !tolerated.includes(response.status)) {
    throw new GatewayUnavailableError("key_management", `${path} answered ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayUnavailableError("key_management", `${path} answered ${response.status} without JSON`);
  }
}

async function mint(principal: Principal, deps: KeyDeps): Promise<GatewayKeyData> {
  keySecret(deps.keySecret);
  const caps = await capsOf(principal, deps);
  const body = generateKeyBody(principal, caps, deps.messageText ?? MESSAGE_TEXT_OFF);
  const parsed = GeneratedKeySchema.safeParse(await management(deps, "/key/generate", body));
  if (!parsed.success) throw new GatewayUnavailableError("key_management", "/key/generate answered without a key and its token");
  return { litellmKeyId: parsed.data.token, keyCiphertext: encryptKey(deps.keySecret, parsed.data.key), maxBudgetUsd: body.max_budget, tokensPerMinute: body.tpm_limit };
}

/**
 * A key no row holds: revoked at the gateway at once, so nothing is left with a live budget (§ 9). A key the
 * gateway no longer knows counts as deleted (404). A delete the gateway refuses leaves a live but unreferenced
 * key, logged by its gateway id for cleanup; the key itself and its ciphertext never appear in the line.
 */
async function revoke(litellmKeyId: string, deps: KeyDeps): Promise<void> {
  try {
    await management(deps, "/key/delete", { keys: [litellmKeyId] }, [404]);
  } catch (error: unknown) {
    console.error(`the gateway refused to delete key ${litellmKeyId}, which no row holds; revoke it at the gateway: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The row a concurrent call wrote while this one was minting; a principal whose row vanished again is refused, never minted for twice. */
async function winner(principal: Principal, deps: KeyDeps): Promise<KeyInfo> {
  const row = await deps.db.findKey(principal);
  if (row === null) {
    throw new AppError("GATEWAY_KEYS_UNAVAILABLE", `the key row of ${principalId(principal)} was taken and removed by another call while this one minted; ask again.`);
  }
  return infoOf(row);
}

/** The principal's key, minted on first use (spec § 7.2 `/keys/ensure`); concurrent callers all get the one row. */
export async function ensureKey(principal: Principal, deps: KeyDeps): Promise<KeyInfo> {
  const existing = await deps.db.findKey(principal);
  if (existing !== null) return infoOf(existing);
  const fresh = await mint(principal, deps);
  try {
    return infoOf(await deps.db.insertKey(principal, fresh));
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) throw error;
  }
  await revoke(fresh.litellmKeyId, deps);
  return winner(principal, deps);
}

/** A new key replaces the old in the row, and only then is the old one deleted at the gateway; a principal without a key gets one. */
export async function rotateKey(principal: Principal, deps: KeyDeps): Promise<KeyInfo> {
  const existing = await deps.db.findKey(principal);
  if (existing === null) return ensureKey(principal, deps);
  const fresh = await mint(principal, deps);
  const replaced = await deps.db.replaceKey(principal, fresh, deps.now(), existing.litellmKeyId);
  if (replaced === null) {
    await revoke(fresh.litellmKeyId, deps);
    return winner(principal, deps);
  }
  await revoke(existing.litellmKeyId, deps);
  return infoOf(replaced);
}
