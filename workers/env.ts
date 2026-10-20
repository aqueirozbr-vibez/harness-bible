import { AppError } from "@/lib/errors";
import { principalOfId, type Principal } from "@/lib/schemas/gateway";

import type { IndividualCaps } from "./keys";

/*
 * The variables feature-specs/11 § 8 gives to the workers alone: `LITELLM_MASTER_KEY` (mints and deletes virtual
 * keys) and the individual account's caps (D5, owed). They never join lib/env.ts, the web tier's schema, and are
 * read here from the workers' own process, by `workers/main.ts` and `scripts/gateway-key.ts`. `GATEWAY_URL` and
 * `GATEWAY_KEY_SECRET` are shared with the app and come from lib/env.ts. `listenAddressOf` reads the app's
 * `WORKERS_URL` the other way round, as the address this process binds.
 */

export interface WorkersEnv {
  readonly masterKey: string | undefined;
  /** null while D5 is undecided: an individual account then gets no key (workers/keys.ts). */
  readonly individual: IndividualCaps | null;
}

type EnvMap = Readonly<Record<string, string | undefined>>;

/** An empty value counts as unset, as lib/env.ts reads its variables. */
function read(source: EnvMap, name: string): string | undefined {
  const value = source[name];
  return value === undefined || value === "" ? undefined : value;
}

/** D5: both numbers are owed; while either is unset the caps are null, and a value that is not a whole number is refused (rules § 4.5). */
export function individualCapsOf(source: EnvMap): IndividualCaps | null {
  const cap = read(source, "INDIVIDUAL_TOKEN_CAP");
  const tpm = read(source, "INDIVIDUAL_TOKENS_PER_MINUTE");
  if (cap === undefined || tpm === undefined) return null;
  if (!/^\d+$/.test(cap) || !/^\d+$/.test(tpm)) {
    throw new AppError("WORKERS_ENV_INVALID", "INDIVIDUAL_TOKEN_CAP and INDIVIDUAL_TOKENS_PER_MINUTE must be whole numbers (see .env.example).");
  }
  return { tokenCap: BigInt(cap), tokensPerMinute: Number(tpm) };
}

export function workersEnv(source: EnvMap = process.env): WorkersEnv {
  return { masterKey: read(source, "LITELLM_MASTER_KEY"), individual: individualCapsOf(source) };
}

/**
 * The principal `npm run gateway:check` uses when it is called without `--org` or `--user` (spec § 3.6 runs the
 * smoke test bare): `GATEWAY_CHECK_PRINCIPAL=org:<id>` or `user:<id>`, an id the operator sets in `.env`, never a
 * value this code invents. Null while it is unset; a value in neither form is refused.
 */
export function checkPrincipalOf(source: EnvMap = process.env): Principal | null {
  const value = read(source, "GATEWAY_CHECK_PRINCIPAL");
  if (value === undefined) return null;
  const principal = principalOfId(value);
  if (principal === null) throw new AppError("WORKERS_ENV_INVALID", "GATEWAY_CHECK_PRINCIPAL must be org:<organisationId> or user:<userId> (see .env.example).");
  return principal;
}

/** The port `http://workers` implies: a URL that names no port means its protocol's own. */
const HTTP_PORT = 80;

export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

/**
 * The address `workers/main.ts` binds, from `WORKERS_URL` (spec § 7.1: the workers listen where the app dials
 * them). A URL without a port means the protocol's own port — `http://workers` on compose's internal network is
 * port 80 — never port 0, which asks the operating system for a free port and would leave the app dialling an
 * address nothing listens on. What this plain `node:http` surface cannot honour is refused here instead: another
 * protocol, and a path, query or fragment, because `lib/workers/client.ts` concatenates `${baseUrl}${route}` and
 * a trailing slash alone would ask for `//health`.
 */
export function listenAddressOf(value: string): ListenAddress {
  const refuse = (reason: string): never => {
    throw new AppError("WORKERS_URL_INVALID", `WORKERS_URL ${reason} (feature-specs/11 § 7.1; see .env.example).`);
  };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse("is not a URL");
  }
  if (url.protocol !== "http:") return refuse("must be an http: URL: the workers' surface is plain HTTP on a private network");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || value.endsWith("/")) return refuse("must be an origin without a path, query or fragment, not even a trailing slash");
  return { host: url.hostname, port: url.port === "" ? HTTP_PORT : Number(url.port) };
}

/**
 * Production boot refuses a missing `GATEWAY_KEY_SECRET` or `LITELLM_MASTER_KEY` in the workers (spec § 8, the
 * pattern of 09 § 10); in development the routes that need them refuse per request instead.
 */
export function requireWorkersSecrets(production: boolean, secrets: { readonly keySecret: string | undefined; readonly masterKey: string | undefined }): void {
  if (!production) return;
  const missing = [secrets.keySecret === undefined ? "GATEWAY_KEY_SECRET" : null, secrets.masterKey === undefined ? "LITELLM_MASTER_KEY" : null].filter((name) => name !== null);
  if (missing.length > 0) throw new AppError("WORKERS_ENV_MISSING", `${missing.join(" and ")} required in production (feature-specs/11 § 8).`);
}

/** The workflow engine the workers are a worker of (feature-specs/28 § 3, § 4). */
export interface EngineConfig {
  /** A host and a port, no scheme (lib/schemas/workflows.ts `TemporalAddressSchema`). */
  readonly address: string;
  readonly namespace: string;
}

/** Null when no engine is configured. An address without a namespace is a configuration error, not a default. */
export function engineConfigOf(values: { readonly address: string | undefined; readonly namespace: string | undefined }): EngineConfig | null {
  if (values.address === undefined) return null;
  if (values.namespace === undefined) {
    throw new Error("TEMPORAL_NAMESPACE is not set: with TEMPORAL_ADDRESS the workers need the namespace compose registers (see .env.example).");
  }
  return { address: values.address, namespace: values.namespace };
}
