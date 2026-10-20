import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/lib/db/generated/client";
import { currentTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

/*
 * The one Prisma client (feature-specs/04 § 4). Three guards live here:
 * 1. content tables are read-only unless the ingest process set PIPELINE=1,
 *    with the embedding job's one exemption under EMBED=1 (feature-specs/12
 *    D3): Section's three embedding columns and nothing else;
 * 2. tenant models are queried only inside a tenant context, and the
 *    organisationId is injected into every query on them;
 * 3. the ledger is append-only (feature-specs/14 § 4.1, invariant 16): an
 *    update or a delete is refused here, before the migration's trigger would;
 * 4. the gateway's rows (feature-specs/11 § 6) belong to a principal, an
 *    organisation or an individual user: the tenant context's organisationId
 *    is injected when it has one, else its userId, and BudgetLedger rows are
 *    never updated or deleted.
 */

const CONTENT_MODELS: ReadonlySet<string> = new Set([
  "Release", "Chapter", "ChapterVersion", "Edition", "Section", "Figure", "DeriveLink", "SourceRow", "CrossReference", "Lab", "LabFile",
]);

/** The embedding job's three columns (feature-specs/12 § 4.1): what a model computed from the book, not what the book says. */
const EMBEDDING_COLUMNS: ReadonlySet<string> = new Set(["embedding", "embeddingModel", "embeddedAt"]);

export interface ContentWriteFlags {
  readonly pipeline: boolean;
  readonly embed: boolean;
}

/**
 * Invariant 3 with its one exemption (feature-specs/12 D3): content rows are the pipeline's under `PIPELINE=1`,
 * and under `EMBED=1` the embedding job may update `Section`'s three embedding columns and nothing else. An
 * update naming any other column, another model, or any operation but an update is refused as before, so the
 * exemption cannot widen into a second writer of the book.
 */
export function contentWriteAllowed(model: string, operation: string, args: unknown, flags: ContentWriteFlags): boolean {
  if (!CONTENT_MODELS.has(model) || !WRITE_OPERATIONS.has(operation)) return true;
  if (flags.pipeline) return true;
  if (!flags.embed || model !== "Section") return false;
  if (operation !== "update" && operation !== "updateMany") return false;
  const data = isRecord(args) ? args.data : undefined;
  if (!isRecord(data)) return false;
  const columns = Object.keys(data);
  return columns.length > 0 && columns.every((column) => EMBEDDING_COLUMNS.has(column));
}

/**
 * Account-scoped models and the column the session value is injected into (feature-specs/05 § 4.1).
 *
 * The improvement models (Suggestion and the thirteen beside it) are deliberately in none of the lists below: they
 * are the platform's, as the ledger is (feature-specs/29 § 2). Nothing is injected into a query on them, so the
 * condition that makes a row the caller's is written in lib/db/improve.ts, the one module that may name them
 * (tests/improve-schema.test.ts and tests/improve-door.test.ts hold both halves of that).
 */
const TENANT_MODELS: ReadonlyMap<string, "userId" | "organisationId"> = new Map([
  ["Bookmark", "userId"],
  ["Note", "userId"],
  ["ReadingPathProgress", "userId"],
  ["Session", "userId"],
  ["Identity", "userId"],
  ["AuthEvent", "userId"],
  ["IdempotencyKey", "userId"],
  /* The assistant's activity (feature-specs/15 § 3): every row carries the reader's own id, so one reader's
     conversations are invisible to another's by construction rather than by a WHERE clause somebody remembered. */
  ["Conversation", "userId"],
  ["Message", "userId"],
  ["Citation", "userId"],
  ["SensorVerdict", "userId"],
  ["Flag", "userId"],
  /* Research (feature-specs/40 § 3): a run and what it found are the asker's own rows, keyed by the reader's id. */
  ["ResearchRun", "userId"],
  ["ResearchFinding", "userId"],
  /* A person's research conversation (feature-specs/48 § 4): the asker's own row, as their runs are. */
  ["ResearchConversation", "userId"],
  ["ProposalEndorsement", "userId"],
  /* A person's sends to Improve, a month's count (feature-specs/48 § 8.3, D5; review of unit 74). */
  ["ResearchSendMonth", "userId"],
  ["User", "organisationId"],
  ["Seat", "organisationId"],
]);

/**
 * The authentication exemption (feature-specs/08 D6, 09 § 4.3): inside
 * `withSystem()` these models are queried without the injected filter, because
 * the sign-in code must find the session row and resolve the user before a
 * tenant exists. No other model is ever exempt.
 */
const SYSTEM_MODELS: ReadonlySet<string> = new Set(["Session", "User", "Identity", "AuthEvent"]);

/** Models keyed by principal (feature-specs/11 § 6): `organisationId` when the tenant has one, else `userId`. */
const PRINCIPAL_MODELS: ReadonlySet<string> = new Set(["GatewayKey", "BudgetLedger"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Operations the append-only ledger refuses; `create` is left to `lib/ledger/append.ts`, its one caller. */
const LEDGER_MUTATIONS: ReadonlySet<string> = new Set(["update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"]);

const WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  "create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany",
]);

/** Operations that take a `where` the tenant filter can be merged into. */
const FILTERED_OPERATIONS: ReadonlySet<string> = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "update", "updateMany", "delete", "deleteMany", "count", "aggregate", "groupBy",
]);

/**
 * The column a principal model is filtered by: an organisation when the context names one, else the individual
 * user. With no context, or a context naming neither, the answer is `organisationId` so the NO_TENANT check
 * below refuses the query rather than reading another principal's rows.
 */
function principalColumn(tenant: ReturnType<typeof currentTenant>): "userId" | "organisationId" {
  if (tenant === undefined) return "organisationId";
  if (tenant.organisationId !== null) return "organisationId";
  if (tenant.userId !== null) return "userId";
  return "organisationId";
}

function connectionString(): string {
  if (env.DATABASE_URL === undefined) {
    throw new AppError("NO_DATABASE", "DATABASE_URL is not set; the release database is required (feature-specs/04 § 8).");
  }
  return env.DATABASE_URL;
}

function buildClient() {
  const adapter = new PrismaPg({ connectionString: connectionString() });
  const base = new PrismaClient({ adapter });
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!contentWriteAllowed(model, operation, args, { pipeline: env.PIPELINE === "1", embed: env.EMBED === "1" })) {
            throw new AppError("CONTENT_READ_ONLY", `${model}.${operation}: content rows are written only by the ingest process, and Section's embedding columns by the embedding job under EMBED=1 (architecture § 11.3; feature-specs/12 § 4.2).`);
          }
          if (model === "LedgerRecord" && LEDGER_MUTATIONS.has(operation)) {
            throw new AppError("LEDGER_APPEND_ONLY", `LedgerRecord.${operation}: ledger records are appended through lib/ledger/append() and never changed (architecture § 11.16).`);
          }
          if (model === "BudgetLedger" && LEDGER_MUTATIONS.has(operation)) {
            throw new AppError("BUDGET_APPEND_ONLY", `BudgetLedger.${operation}: budget rows are appended per model call and never changed (feature-specs/11 § 6).`);
          }
          const principal = PRINCIPAL_MODELS.has(model);
          const column = principal ? principalColumn(currentTenant()) : TENANT_MODELS.get(model);
          if (column !== undefined) {
            const tenant = currentTenant();
            if (tenant === undefined) {
              throw new AppError("NO_TENANT", `${model}.${operation}: no tenant context; run the query inside withTenant().`);
            }
            if (tenant.system === "auth" && SYSTEM_MODELS.has(model)) return query(args);
            const value = tenant[column];
            if (principal && value === null) {
              throw new AppError("NO_TENANT", `${model}.${operation}: the tenant context names no principal; run the query inside withTenant() with an organisationId or a userId.`);
            }
            const a = args as { where?: Record<string, unknown>; data?: unknown; create?: Record<string, unknown> };
            if (FILTERED_OPERATIONS.has(operation)) a.where = { ...(a.where ?? {}), [column]: value };
            if (operation === "create" && isRecord(a.data)) a.data = { ...a.data, [column]: value };
            if ((operation === "createMany" || operation === "createManyAndReturn") && Array.isArray(a.data)) a.data = a.data.map((d) => (isRecord(d) ? { ...d, [column]: value } : d));
            if (operation === "upsert" && isRecord(a.create)) a.create = { ...a.create, [column]: value };
          }
          return query(args);
        },
      },
    },
  });
}

export type ExtendedClient = ReturnType<typeof buildClient>;

const globalForPrisma = globalThis as unknown as { prisma?: ExtendedClient };
let client: ExtendedClient | undefined;

/**
 * The shared client, built on first use so that importing a loader without
 * DATABASE_URL (unit tests, a dry-run ingest) does not throw. One instance per
 * process; the dev server reloads modules, so it is also kept on globalThis.
 */
export function getPrisma(): ExtendedClient {
  if (client !== undefined) return client;
  client = globalForPrisma.prisma ?? buildClient();
  if (env.NODE_ENV !== "production") globalForPrisma.prisma = client;
  return client;
}
