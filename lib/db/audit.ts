import { clientIp, hashIp } from "@/lib/api/ip";
import { deviceOf } from "@/lib/auth/rules";
import { getPrisma } from "@/lib/db/client";
import { withSystem } from "@/lib/db/tenant";
import { env } from "@/lib/env";

/*
 * The Phase 1 audit table (feature-specs/09 § 8.6): one row per sign-in,
 * refusal, sign-out, revocation, deletion request, identity link and policy
 * deny. `detail` holds codes and ids, never free text or an e-mail; the address
 * is a salted daily hash; the user agent is the device summary key.
 */

export type AuthEventKind = "sign_in" | "sign_in_refused" | "sign_out" | "sign_out_all" | "session_revoked" | "backchannel_logout" | "role_changed" | "deletion_requested" | "identity_linked" | "identity_unlinked" | "policy_denied" | "roster_set" | "research_set" | "research_org_created";

export interface AuthEventInput {
  readonly kind: AuthEventKind;
  readonly userId: string | null;
  readonly sessionId?: string | null;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
  readonly traceId: string;
  /** The request, or the two facts it would give. */
  readonly request?: Request | { readonly ip: string; readonly userAgent: string | null };
}

export const AUTH_EVENT_RETENTION_DAYS = 90;

/** Writes the row; never throws (an audit failure must not fail the request) and never includes an e-mail. */
export async function recordAuthEvent(input: AuthEventInput): Promise<void> {
  if (env.DATABASE_URL === undefined) return;
  const ip = input.request === undefined ? "0.0.0.0" : input.request instanceof Request ? clientIp(input.request) : input.request.ip;
  const userAgent = input.request === undefined ? null : input.request instanceof Request ? input.request.headers.get("user-agent") : input.request.userAgent;
  const detail = Object.fromEntries(Object.entries(input.detail ?? {}).filter(([, v]) => typeof v !== "string" || !v.includes("@")));
  try {
    await withSystem(() =>
      getPrisma().authEvent.create({
        data: { userId: input.userId, sessionId: input.sessionId ?? null, kind: input.kind, detail, ipHash: hashIp(ip), userAgent: deviceOf(userAgent), traceId: input.traceId },
      }),
    );
  } catch (error) {
    console.warn("audit write failed", error instanceof Error ? error.message : String(error));
  }
}

export async function sweepAuthEvents(now = new Date()): Promise<number> {
  const result = await withSystem(() => getPrisma().authEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - AUTH_EVENT_RETENTION_DAYS * 86_400_000) } } }));
  return result.count;
}
