import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Tenant context for account-scoped queries (feature-specs/04 § 4.1, 05 § 4.1).
 * A page, server action or handler runs its work inside `withTenant`; the
 * Prisma client extension reads the context and injects the session's
 * `userId` (user-scoped models) or `organisationId` (organisation-scoped
 * models) into every query on those models. No context means no query.
 *
 * `withSystem` is the one documented exemption (feature-specs/08 D6): the
 * authentication code must find a `Session` row before it knows the user, and
 * resolve or create a `User` before it has a tenant. Inside it, the guard skips
 * injection for the auth models only (`lib/db/client.ts` names them).
 */
export interface TenantContext {
  readonly userId: string | null;
  readonly organisationId: string | null;
  /** Set only by `withSystem`; names the reason for the audit trail. */
  readonly system?: "auth";
}

/* One storage per process, kept on globalThis like the Prisma client: the dev
   server reloads this module, and the client's extension must keep reading the
   storage that `withTenant` writes to. */
const globalForTenant = globalThis as unknown as { tenantStorage?: AsyncLocalStorage<TenantContext> };
const storage: AsyncLocalStorage<TenantContext> = globalForTenant.tenantStorage ?? new AsyncLocalStorage<TenantContext>();
globalForTenant.tenantStorage = storage;

export function withTenant<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
  /* Prisma promises execute on `.then`; awaiting inside the store keeps that call in context. */
  return storage.run(context, async () => {
    const result = await fn();
    return result;
  });
}

/** The authentication exemption: queries on the auth models run unfiltered inside `fn`. */
export function withSystem<T>(fn: () => Promise<T>): Promise<T> {
  return withTenant({ userId: null, organisationId: null, system: "auth" }, fn);
}

export function currentTenant(): TenantContext | undefined {
  return storage.getStore();
}
