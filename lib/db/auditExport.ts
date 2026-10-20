import { getPrisma } from "@/lib/db/client";
import { mergedOfChapter, revertIdsOf, suggestionIdsOf } from "@/lib/db/improve";
import { countSelected } from "@/lib/db/ledger";
import { withSystem } from "@/lib/db/tenant";
import { viewOf, type ExportScope } from "@/lib/ledger/export";
import { ledgerKindsOf, type AuditExportScopeColumn, type AuditScope } from "@/lib/schemas/audit";

export { auditExportsToday, createAuditExport, dayOf, latestOwnAuditExport, readAuditExport, readOwnAuditExport, removeAuditExport, writeAuditExportReady, type AuditExportRow, type AuditPackFacts } from "@/lib/db/improve";

/*
 * The audit export's composition (feature-specs/38 § 3; unit 55b): the scope's resolution into the ledger's terms — an
 * account's pseudonyms and its suggestions' ids, a chapter's merged suggestions' — which the estimate, the file and
 * nothing else need; and the estimate itself. The rows are the door's (`lib/db/improve.ts`: `AuditExport` is a table
 * of the improvement block), re-exported here for the endpoint and the workflow. The policy decides who asks and who
 * reads (policies/hb/audit.rego).
 */

/**
 * The scope in the ledger's terms (38 § 3): an account's pseudonyms and its suggestions' ids — a person's own, or an
 * organisation's members' — or a chapter's merged suggestions' ids, as its public history has them (35 D2).
 */
export async function resolveAuditScope(scope: AuditScope): Promise<ExportScope & { readonly kind: "account" | "chapter" }> {
  if (scope.kind === "chapter") {
    const merged = await mergedOfChapter(Number(scope.id));
    return { kind: "chapter", id: scope.id, suggestionIds: merged.map((row) => row.id) };
  }
  const members = await withSystem(() => getPrisma().user.findMany({ where: { OR: [{ id: scope.id }, { organisationId: scope.id }] }, select: { id: true } }));
  const ids = members.map((member) => member.id);
  const own = await suggestionIdsOf(ids);
  /* the reverts of the account's merged changes, whose records are the revert's (37 § 8): an undoing is part of what was decided about one's contributions */
  const reverts = await revertIdsOf(own);
  return { kind: "account", id: scope.id, actors: ids.map((id) => `user:${id}`), suggestionIds: [...own, ...reverts.filter((id) => !own.includes(id))] };
}

/** The scope with the request's window and kinds, as `exportJsonl` takes it. */
export function exportScopeOf(request: AuditExportScopeColumn, resolved: ExportScope & { readonly kind: "account" | "chapter" }): ExportScope {
  return { ...resolved, from: new Date(request.from), to: new Date(request.to), kinds: ledgerKindsOf(request.kinds) };
}

/** How many records the request selects now (38 § 3: a count, never a guess). */
export async function estimateAuditExport(request: AuditExportScopeColumn): Promise<number> {
  const scope = exportScopeOf(request, await resolveAuditScope(request.scope));
  if ("seqs" in scope || scope.kind === "all" || scope.kind === "suggestion") return 0;
  return countSelected({ view: viewOf(scope), from: scope.from ?? null, to: scope.to ?? null, kinds: scope.kinds ?? null });
}
