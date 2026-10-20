import { env } from "@/lib/env";

/*
 * Whether the development provider answers on this deployment (feature-specs/08 § 5.7): where it is switched on,
 * and never in production. lib/env.ts also refuses to start a production process that has it switched on (09
 * § 8.5), so the second half is said twice on purpose.
 *
 * Its own file, with no import of the framework, because two things ask: the sign-in endpoint, and the function
 * that lets that endpoint say what role a development account has (lib/auth/link.ts; feature-specs/29 § 6.4), which
 * scripts and the workers load too.
 */
export function devProviderEnabled(): boolean {
  return env.AUTH_DEV_PROVIDER === "1" && env.NODE_ENV !== "production";
}
