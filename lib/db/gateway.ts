import { tenantOfPrincipal } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { withTenant } from "@/lib/db/tenant";
import { isRecordNotFound } from "@/lib/errors";
import type { Principal } from "@/lib/schemas/gateway";

/*
 * The GatewayKey rows (feature-specs/11 § 3.4, § 6): one per principal, the key stored as a ciphertext only the
 * workers can open. The web tier may read that a key exists and when it was rotated; the ciphertext is inert
 * without GATEWAY_KEY_SECRET. Every query runs inside the principal's tenant context.
 */

export interface GatewayKeyRow {
  readonly id: string;
  readonly litellmKeyId: string;
  readonly keyCiphertext: string;
  /** The Decimal as the database prints it. */
  readonly maxBudgetUsd: string;
  readonly tokensPerMinute: number;
  readonly createdAt: Date;
  readonly rotatedAt: Date | null;
}

export interface GatewayKeyData {
  readonly litellmKeyId: string;
  readonly keyCiphertext: string;
  readonly maxBudgetUsd: number;
  readonly tokensPerMinute: number;
}

const SELECT = { id: true, litellmKeyId: true, keyCiphertext: true, maxBudgetUsd: true, tokensPerMinute: true, createdAt: true, rotatedAt: true } as const;

type Selected = { readonly maxBudgetUsd: { toString(): string } } & Omit<GatewayKeyRow, "maxBudgetUsd">;

function toRow(row: Selected): GatewayKeyRow {
  return { ...row, maxBudgetUsd: row.maxBudgetUsd.toString() };
}

export async function findGatewayKey(principal: Principal): Promise<GatewayKeyRow | null> {
  const row = await withTenant(tenantOfPrincipal(principal), () => getPrisma().gatewayKey.findFirst({ where: {}, select: SELECT }));
  return row === null ? null : toRow(row);
}

export async function insertGatewayKey(principal: Principal, data: GatewayKeyData): Promise<GatewayKeyRow> {
  const row = await withTenant(tenantOfPrincipal(principal), () => getPrisma().gatewayKey.create({ data, select: SELECT }));
  return toRow(row);
}

/**
 * A rotation: the new key replaces the old in place and `rotatedAt` records when (spec § 3.4). The write names
 * the key it is replacing, so a rotation that another rotation overtook writes nothing and returns null instead
 * of overwriting the winner's `litellmKeyId` and orphaning a budgeted key at the gateway.
 */
export async function replaceGatewayKey(principal: Principal, data: GatewayKeyData, rotatedAt: Date, replacing: string): Promise<GatewayKeyRow | null> {
  try {
    const row = await withTenant(tenantOfPrincipal(principal), () => getPrisma().gatewayKey.update({ where: { litellmKeyId: replacing }, data: { ...data, rotatedAt }, select: SELECT }));
    return toRow(row);
  } catch (error: unknown) {
    if (isRecordNotFound(error)) return null;
    throw error;
  }
}

export interface OrganisationCaps {
  readonly tokenCap: bigint;
  readonly tokensPerMinute: number;
}

/** The organisation's caps the key is minted with; null when no such organisation exists. Not a tenant model. */
export function organisationCaps(organisationId: string): Promise<OrganisationCaps | null> {
  return getPrisma().organisation.findUnique({ where: { id: organisationId }, select: { tokenCap: true, tokensPerMinute: true } });
}

/** Whether the user exists as an individual account (no organisation): the tenant guard adds `organisationId: null` to the lookup. */
export async function isIndividualUser(userId: string): Promise<boolean> {
  const row = await withTenant({ userId, organisationId: null }, () => getPrisma().user.findUnique({ where: { id: userId }, select: { id: true } }));
  return row !== null;
}

/**
 * The GatewayKey rows the workers can open, for `/health` (feature-specs/11 § 7.2): the organisations with a key
 * (not a tenant model) plus the individual users with one, read inside the individual context the guard filters
 * by `organisationId: null`. No principal context spans the table, and no query bypasses the guard.
 */
export async function countGatewayKeys(): Promise<number> {
  const prisma = getPrisma();
  const organisations = await prisma.organisation.count({ where: { gatewayKey: { isNot: null } } });
  const individuals = await withTenant({ userId: null, organisationId: null }, () => prisma.user.count({ where: { gatewayKey: { isNot: null } } }));
  return organisations + individuals;
}
