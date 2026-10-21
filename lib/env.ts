import { z } from "zod";

import { TemporalAddressSchema, TemporalNamespaceSchema } from "@/lib/schemas/workflows";

/*
 * The only place process.env is read (code-standards § Next.js).
 * Every variable is validated once at boot and exported typed.
 */
const EnvSchema = z
  .object({
    /** Absent only in unit tests; every page and loader needs the release database (feature-specs/04). */
    DATABASE_URL: z.url().optional(),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Path to the book checkout: the folder holding book/ and labs/. */
    BOOK_DIR: z.string().min(1).default("../bible"),
    /** Release id the pipeline ingests as. */
    RELEASE_ID: z.string().regex(/^\d{4}\.(0[1-9]|1[0-2])(\.([2-9]|[1-9]\d+))?$/).default("2026.09"),
    /** CI's render hash; ingestion aborts when the recomputed hash differs. */
    RENDER_HASH_EXPECTED: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** Set to "1" only by the ingest process; the only thing that may write content rows (architecture § 11.3). */
    PIPELINE: z.enum(["1"]).optional(),
    /** Set to "1" only by the embedding job: under it alone a Section's three embedding columns may be written (feature-specs/12 § 4.2, D3). */
    EMBED: z.enum(["1"]).optional(),
    /** Absolute origin of this deployment: redirect URIs, allowed origins, form-action (feature-specs/08 § 5.6). */
    APP_URL: z.url().default("http://localhost:3000"),
    /** Keycloak realm issuer, e.g. https://auth.example/realms/harness-bible (feature-specs/09 § 10). */
    KEYCLOAK_ISSUER: z.url().optional(),
    KEYCLOAK_CLIENT_ID: z.string().min(1).default("hb-web"),
    KEYCLOAK_CLIENT_SECRET: z.string().min(1).optional(),
    /** Optional pilot allow-list: comma-separated e-mails and `@domain` entries; empty allows everyone (08 D7). */
    AUTH_ALLOWED_EMAILS: z.string().default(""),
    /** "1" enables GET /api/v1/auth/dev; refused under NODE_ENV=production (08 § 5.7). */
    AUTH_DEV_PROVIDER: z.enum(["1"]).optional(),
    /** OPA sidecar; unset means every policy decision is a deny (09 D6). */
    OPA_URL: z.url().optional(),
    /** Salt for AuthEvent.ipHash (09 § 8.6). */
    IP_HASH_SALT: z.string().min(8).default("development-salt"),
    /** The decision-aid runner (lib/aids/run.ts): `docker` runs the lab tier's container, `python` a local subprocess. */
    AID_RUNNER: z.enum(["python", "docker"]).default("docker"),
    /** The interpreter for the `python` runner. */
    PYTHON_BIN: z.string().min(1).default("python"),
    /** The docker binary and image for the `docker` runner. */
    DOCKER_BIN: z.string().min(1).default("docker"),
    AID_IMAGE: z.string().min(1).default("python:3.12-slim"),
    /** The Ed25519 private key (PEM) that signs ledger export trailers; absent = exports refuse, appends still work (feature-specs/14 § 7). */
    LEDGER_EXPORT_KEY: z.string().min(1).optional(),
    /** The model gateway's base URL (feature-specs/11 § 8): LiteLLM in compose or the stub on 4001; unset = every model call is GatewayUnavailableError. */
    GATEWAY_URL: z.url().optional(),
    /** Decrypts GatewayKey.keyCiphertext (11 § 3.4): 32 bytes as 64 hex characters; the workers hold it, the web container leaves it unset by design. */
    GATEWAY_KEY_SECRET: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /**
     * Who pays for a signed-out reader's query embedding (feature-specs/12 § 6, D4; Andre's answer of 2026-09-24,
     * "for everyone"): `org:<organisationId>` or `user:<userId>`, the form GATEWAY_CHECK_PRINCIPAL uses. Unset = an
     * anonymous search has no principal and stays lexical.
     */
    GATEWAY_ANONYMOUS_PRINCIPAL: z.string().regex(/^(?:org|user):.+$/, "GATEWAY_ANONYMOUS_PRINCIPAL must be org:<organisationId> or user:<userId> (see .env.example)").optional(),
    /**
     * The principal research is charged to (feature-specs/40 § 7.1, A6): an organisation of the operator's, whose key's
     * cap at the gateway is the month's research budget (A14: US$ 20). The workers read its value: since unit 74 it pays
     * Improve's vetting of the findings people send as researcher proposals (feature-specs/48 § 7.3), and the legacy runs
     * still in flight. The web tier reads only its presence (48 § 8.3): unset, research proposals are not configured
     * here, the send answers 503 and the page offers the button disabled; a person's own research needs none of it.
     */
    RESEARCH_PRINCIPAL: z.string().regex(/^org:.+$/, "RESEARCH_PRINCIPAL must be org:<organisationId> (see .env.example)").optional(),
    /**
     * The fixed cap of an individual account, tokens a month (11 D5; a number Andre owes). The workers mint the key
     * with it (`workers/env.ts` reads it with its tokens per minute); the web tier reads it only to print the cap
     * on the budget meter (feature-specs/21 § 4.1). Unset = the meter says `no cap set`.
     */
    INDIVIDUAL_TOKEN_CAP: z.string().regex(/^\d+$/, "INDIVIDUAL_TOKEN_CAP must be a whole number of tokens (see .env.example)").optional(),
    /**
     * The OTLP/HTTP endpoint of the collector (feature-specs/21 D3), e.g. http://localhost:4318. Set, the web tier,
     * the workers and the scheduled jobs export their spans to it; unset (development, CI), nothing is exported and
     * no OpenTelemetry code loads: the JSON lines are all there is.
     */
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    /**
     * The workers' half of the development-only text switch (feature-specs/49 § 9.1): `on` lets a successful call's
     * prompt and answer reach Langfuse, through the gateway and the collector's own half, and only behind
     * `messageTextGate` below. `true`, `1` or `yes` are refused rather than read as anything; refused in production.
     */
    LANGFUSE_MESSAGE_TEXT: z.enum(["on", "off"]).default("off"),
    /** The workers' private surface (11 § 7, § 8): the app dials this URL and the workers listen at its host and port; unset = WorkersUnavailableError. */
    WORKERS_URL: z.url().optional(),
    /** The shared bearer of that channel (11 D7), held by the app and the workers. */
    WORKERS_TOKEN: z.string().min(1).optional(),
    /**
     * The workflow engine's frontend (feature-specs/28 § 3): a host and a port, no scheme, e.g. 127.0.0.1:7233 for the
     * compose `temporal` service. Unset, nothing that needs a workflow runs; the reader and the assistant need none.
     */
    TEMPORAL_ADDRESS: TemporalAddressSchema.optional(),
    /** The engine's namespace for this deployment (28 § 3): `harness-bible`, the one compose registers. */
    TEMPORAL_NAMESPACE: TemporalNamespaceSchema.optional(),
    /**
     * Object storage is a directory for now (feature-specs/32 § 5, § 15; Andre, 2026-10-06: "stored locally, we
     * don't have a cloud infra"): the uploads and the fetched evidence live under it, by key. A bucket replaces the
     * directory behind lib/storage/ when there is one.
     */
    OBJECT_STORE_DIR: z.string().min(1).default(".store"),
    /** Signs the URLs that reach an object (32 § 5): 32 bytes as 64 hex characters; unset = the storage routes refuse (STORAGE_UNAVAILABLE). */
    OBJECT_STORE_SECRET: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /**
     * The share of a curator's queue that seeds may make up (feature-specs/36 § 7.1): a share under 1, such as 0.05.
     * Unset or 0, no seed is ever offered (A16); Andre sets the number.
     */
    CURATOR_SEED_SHARE: z.string().regex(/^0(\.\d+)?$/, "CURATOR_SEED_SHARE must be a share under 1, such as 0 or 0.05 (see .env.example)").optional(),
    /**
     * The book's Git repository (feature-specs/37 § 3): the one place the product writes the book, and only through
     * pipeline/git.ts. Unset, every merge refuses with BOOK_REPO_UNAVAILABLE; making it is the operator's act.
     */
    BOOK_REPO_DIR: z.string().min(1).optional(),
    /** How many merged suggestions whose strongest item was tier B are drawn per part each month into the "Sampled" group (36 § 7.2, D2). Unset, none. */
    CURATOR_SAMPLE_PER_MONTH: z.string().regex(/^[1-9]\d*$/, "CURATOR_SAMPLE_PER_MONTH must be a whole number above 0 (see .env.example)").optional(),
  })
  .superRefine((value, ctx) => {
    /* `next build` runs under NODE_ENV=production without the runtime secrets; the checks are for `next start`. */
    if (value.NODE_ENV !== "production" || process.env.NEXT_PHASE === "phase-production-build") return;
    if (value.AUTH_DEV_PROVIDER !== undefined) {
      ctx.addIssue({ code: "custom", path: ["AUTH_DEV_PROVIDER"], message: "AUTH_DEV_PROVIDER must be unset in production (feature-specs/09 § 8.5)." });
    }
    if (value.LANGFUSE_MESSAGE_TEXT === "on") {
      ctx.addIssue({ code: "custom", path: ["LANGFUSE_MESSAGE_TEXT"], message: "LANGFUSE_MESSAGE_TEXT must be off in production (feature-specs/49 § 9)." });
    }
    for (const name of ["KEYCLOAK_ISSUER", "KEYCLOAK_CLIENT_SECRET", "OPA_URL"] as const) {
      if (value[name] === undefined) {
        ctx.addIssue({ code: "custom", path: [name], message: `${name} is required in production (feature-specs/09 § 8.5).` });
      }
    }
    for (const name of ["GATEWAY_URL", "WORKERS_URL"] as const) {
      if (value[name] === undefined) {
        ctx.addIssue({ code: "custom", path: [name], message: `${name} is required in production (feature-specs/11 § 8).` });
      }
    }
    if (value.OBJECT_STORE_SECRET === undefined) {
      ctx.addIssue({ code: "custom", path: ["OBJECT_STORE_SECRET"], message: "OBJECT_STORE_SECRET is required in production (feature-specs/32 § 5)." });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * The variables whose values are secrets (feature-specs/21 § 6.1): what the run-time guard looks for, by value,
 * in every line and span before it leaves the process (`lib/security/processSecrets.ts`). A new secret variable
 * joins this list in the same change that adds it to the schema.
 */
export const SECRET_ENV_KEYS = ["DATABASE_URL", "KEYCLOAK_CLIENT_SECRET", "IP_HASH_SALT", "LEDGER_EXPORT_KEY", "GATEWAY_KEY_SECRET", "WORKERS_TOKEN", "OBJECT_STORE_SECRET"] as const satisfies ReadonlyArray<keyof Env>;

/** An empty value counts as unset, so a shell can override a `.env` line with `NAME=`. */
const read = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

export const env: Env = EnvSchema.parse({
  DATABASE_URL: read("DATABASE_URL"),
  NODE_ENV: read("NODE_ENV"),
  BOOK_DIR: read("BOOK_DIR"),
  RELEASE_ID: read("RELEASE_ID"),
  RENDER_HASH_EXPECTED: read("RENDER_HASH_EXPECTED"),
  PIPELINE: read("PIPELINE"),
  EMBED: read("EMBED"),
  APP_URL: read("APP_URL"),
  KEYCLOAK_ISSUER: read("KEYCLOAK_ISSUER"),
  KEYCLOAK_CLIENT_ID: read("KEYCLOAK_CLIENT_ID"),
  KEYCLOAK_CLIENT_SECRET: read("KEYCLOAK_CLIENT_SECRET"),
  AUTH_ALLOWED_EMAILS: read("AUTH_ALLOWED_EMAILS"),
  AUTH_DEV_PROVIDER: read("AUTH_DEV_PROVIDER"),
  OPA_URL: read("OPA_URL"),
  IP_HASH_SALT: read("IP_HASH_SALT"),
  AID_RUNNER: read("AID_RUNNER"),
  PYTHON_BIN: read("PYTHON_BIN"),
  DOCKER_BIN: read("DOCKER_BIN"),
  AID_IMAGE: read("AID_IMAGE"),
  LEDGER_EXPORT_KEY: read("LEDGER_EXPORT_KEY"),
  GATEWAY_URL: read("GATEWAY_URL"),
  GATEWAY_KEY_SECRET: read("GATEWAY_KEY_SECRET"),
  GATEWAY_ANONYMOUS_PRINCIPAL: read("GATEWAY_ANONYMOUS_PRINCIPAL"),
  RESEARCH_PRINCIPAL: read("RESEARCH_PRINCIPAL"),
  INDIVIDUAL_TOKEN_CAP: read("INDIVIDUAL_TOKEN_CAP"),
  OTEL_EXPORTER_OTLP_ENDPOINT: read("OTEL_EXPORTER_OTLP_ENDPOINT"),
  LANGFUSE_MESSAGE_TEXT: read("LANGFUSE_MESSAGE_TEXT"),
  WORKERS_URL: read("WORKERS_URL"),
  WORKERS_TOKEN: read("WORKERS_TOKEN"),
  TEMPORAL_ADDRESS: read("TEMPORAL_ADDRESS"),
  TEMPORAL_NAMESPACE: read("TEMPORAL_NAMESPACE"),
  OBJECT_STORE_DIR: read("OBJECT_STORE_DIR"),
  OBJECT_STORE_SECRET: read("OBJECT_STORE_SECRET"),
  BOOK_REPO_DIR: read("BOOK_REPO_DIR"),
  CURATOR_SEED_SHARE: read("CURATOR_SEED_SHARE"),
  CURATOR_SAMPLE_PER_MONTH: read("CURATOR_SAMPLE_PER_MONTH"),
});

/** Whether a successful call's text may reach Langfuse from this process, and if not, the first reason why not. */
export interface MessageTextGate {
  readonly on: boolean;
  readonly why: string | null;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The development check behind `LANGFUSE_MESSAGE_TEXT=on` (feature-specs/49 § 9.1). `NODE_ENV` defaults to
 * development in the schema and nothing that runs the workers sets it, so a deployment that forgot
 * `NODE_ENV=production` would pass a test of "not production"; the gate wants four positive signs instead: the
 * setting on, `NODE_ENV` exactly `development` as the process received it (before the default), a loopback `APP_URL`
 * as the process received it too (the workers never need `APP_URL`, so its default would pass every deployment of
 * theirs; unit 82's review), and the development sign-in. `why` names the first that failed. Off, it fails closed; nothing refuses to boot.
 */
export function messageTextGateOf(input: { readonly text: "on" | "off"; readonly nodeEnv: string | undefined; readonly appUrl: string | undefined; readonly authDevProvider: string | undefined }): MessageTextGate {
  if (input.text !== "on") return { on: false, why: "LANGFUSE_MESSAGE_TEXT is off" };
  if (input.nodeEnv !== "development") return { on: false, why: input.nodeEnv === undefined ? "NODE_ENV is unset, and only an explicit NODE_ENV=development passes" : `NODE_ENV is ${input.nodeEnv}, not development` };
  if (input.appUrl === undefined) return { on: false, why: "APP_URL is unset, and only an explicit loopback APP_URL passes" };
  const host = new URL(input.appUrl).hostname;
  if (!LOOPBACK_HOSTS.has(host)) return { on: false, why: `APP_URL's host ${host} is not a loopback host` };
  if (input.authDevProvider !== "1") return { on: false, why: "AUTH_DEV_PROVIDER is not 1" };
  return { on: true, why: null };
}

export const messageTextGate: MessageTextGate = messageTextGateOf({ text: env.LANGFUSE_MESSAGE_TEXT, nodeEnv: read("NODE_ENV"), appUrl: read("APP_URL") === undefined ? undefined : env.APP_URL, authDevProvider: env.AUTH_DEV_PROVIDER });
