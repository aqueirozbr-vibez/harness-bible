import { env, SECRET_ENV_KEYS } from "@/lib/env";

/*
 * The values this process must never write out (feature-specs/21 § 6.1: "the literal values of the process's own
 * secret variables: never the names, the values, compared after loading"). The pattern table knows shapes; a
 * session secret, a salt or a bearer generated for one deployment has no shape, so the run-time guard looks for the
 * values themselves.
 *
 * A value shorter than eight characters is left out: the shortest secret the environment's schema accepts is eight
 * (`IP_HASH_SALT`), and a shorter string would be found by accident in ordinary words.
 */

export const SECRET_MIN_LENGTH = 8;

/* Values a process holds outside `lib/env.ts`: the workers' gateway master key (workers/env.ts). */
const registered = new Set<string>();

/** Adds a value the guard must look for; the workers register the gateway's master key at boot. */
export function registerProcessSecret(value: string | undefined): void {
  if (value !== undefined && value.length >= SECRET_MIN_LENGTH) registered.add(value);
}

let fromEnvironment: ReadonlyArray<string> | null = null;

/** The values, longest first so a secret that contains another is taken whole. */
export function processSecrets(): ReadonlyArray<string> {
  fromEnvironment ??= SECRET_ENV_KEYS.flatMap((key) => {
    const value = env[key];
    return typeof value === "string" && value.length >= SECRET_MIN_LENGTH ? [value] : [];
  });
  return [...new Set([...fromEnvironment, ...registered])].sort((a, b) => b.length - a.length);
}
