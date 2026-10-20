"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { newTraceId } from "@/lib/api/trace";
import { clearSessionCookie } from "@/lib/auth/cookies";
import { getSession, revokeOtherSessions, revokeSession, type SessionUser } from "@/lib/auth/session";
import { signInHref } from "@/lib/auth/signIn";
import { requestDeletionFor, unlinkIdentityFor, updateDisplayNameFor, updateLocaleFor } from "@/lib/db/account";
import { recordAuthEvent, type AuthEventKind } from "@/lib/db/audit";
import { getPrisma } from "@/lib/db/client";
import { withSystem } from "@/lib/db/tenant";
import { AppError } from "@/lib/errors";
import { LocaleSchema } from "@/lib/i18n/routing";
import { ownResource, subjectOf, type PolicyAction, type PolicyResource } from "@/lib/policy/input";
import { requireAllowed } from "@/lib/policy/opa";
import { DisplayNameSchema, PreferenceLocaleSchema, ProviderSchema } from "@/lib/schemas/auth";

/*
 * Form actions of the account page (feature-specs/08 § 5.5): zod first, the
 * session second, the policy third (09 § 5.3), the write inside the tenant
 * context, then a redirect that carries the outcome in the URL. Each change
 * that matters is an audit row (09 § 8.6). Signed out → the sign-in page.
 */

function localeOf(formData: FormData): "en" | "pt" {
  const parsed = LocaleSchema.safeParse(formData.get("locale"));
  return parsed.success ? parsed.data : "en";
}

async function requireUser(locale: "en" | "pt"): Promise<SessionUser> {
  const user = await getSession();
  if (user === null) redirect(signInHref(locale, `/${locale}/account`));
  return user;
}

function self(user: SessionUser): PolicyResource {
  return { kind: "user", id: user.id, organisationId: user.organisationId };
}

async function allowedOr(user: SessionUser, action: PolicyAction, resource: PolicyResource, name: string, onDeny: string): Promise<void> {
  try {
    await requireAllowed(subjectOf(user), action, resource, { method: "ACTION", path: name });
  } catch {
    redirect(onDeny);
  }
}

async function audit(kind: AuthEventKind, user: SessionUser, detail: Record<string, string | number | boolean | null> = {}, sessionId: string | null = user.sessionId): Promise<void> {
  const h = await headers();
  await recordAuthEvent({ kind, userId: user.id, sessionId, detail, traceId: newTraceId(), request: { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "0.0.0.0", userAgent: h.get("user-agent") } });
}

export async function updateProfile(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const name = DisplayNameSchema.safeParse(formData.get("displayName"));
  if (!name.success) redirect(`/${locale}/account?error=name`);
  const user = await requireUser(locale);
  await allowedOr(user, "write", self(user), "updateProfile", `/${locale}/account?error=failed`);
  try {
    await updateDisplayNameFor(user, name.data);
  } catch {
    redirect(`/${locale}/account?error=failed`);
  }
  redirect(`/${locale}/account?saved=profile`);
}

export async function updatePreferences(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const choice = PreferenceLocaleSchema.safeParse(formData.get("edition"));
  if (!choice.success) redirect(`/${locale}/account?error=failed`);
  const user = await requireUser(locale);
  await allowedOr(user, "write", self(user), "updatePreferences", `/${locale}/account?error=failed`);
  try {
    await updateLocaleFor(user, choice.data);
  } catch {
    redirect(`/${locale}/account?error=failed`);
  }
  redirect(`/${choice.data}/account?saved=preferences`);
}

export async function revokeOneSession(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const id = z.string().regex(/^[0-9a-f]{64}$/).safeParse(formData.get("sessionId"));
  if (!id.success) redirect(`/${locale}/account?error=failed`);
  const user = await requireUser(locale);
  const row = await withSystem(() => getPrisma().session.findUnique({ where: { id: id.data }, select: { userId: true } }));
  await allowedOr(user, "revoke", { kind: "session", id: id.data, ownerId: row?.userId ?? null, organisationId: user.organisationId }, "revokeOneSession", `/${locale}/account?error=failed#sessions`);
  const revoked = await revokeSession(user, id.data);
  if (revoked) await audit("session_revoked", user, { by: "self", current: user.sessionId === id.data }, id.data);
  if (user.sessionId === id.data) {
    await clearSessionCookie();
    redirect(`/${locale}`);
  }
  redirect(`/${locale}/account?revoked=1#sessions`);
}

export async function revokeOthers(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const user = await requireUser(locale);
  await allowedOr(user, "revoke", ownResource("session", null, user), "revokeOthers", `/${locale}/account?error=failed#sessions`);
  if (user.sessionId !== null) {
    const count = await revokeOtherSessions(user, user.sessionId);
    await audit("sign_out_all", user, { count, keptCurrent: true });
  }
  redirect(`/${locale}/account?revoked=1#sessions`);
}

export async function unlinkIdentity(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const provider = ProviderSchema.safeParse(formData.get("provider"));
  if (!provider.success) redirect(`/${locale}/account?error=failed`);
  const user = await requireUser(locale);
  await allowedOr(user, "write", self(user), "unlinkIdentity", `/${locale}/account?error=failed#identities`);
  try {
    await unlinkIdentityFor(user, provider.data);
  } catch (error) {
    redirect(`/${locale}/account?error=${error instanceof AppError && error.code === "LAST_IDENTITY" ? "last-identity" : "failed"}#identities`);
  }
  await audit("identity_unlinked", user, { idp: provider.data });
  redirect(`/${locale}/account?unlinked=${provider.data}#identities`);
}

export async function requestDeletion(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  if (formData.get("confirm") !== "delete") redirect(`/${locale}/account?error=confirm#retention`);
  const user = await requireUser(locale);
  await allowedOr(user, "write", self(user), "requestDeletion", `/${locale}/account?error=failed#retention`);
  try {
    await requestDeletionFor(user);
  } catch {
    redirect(`/${locale}/account?error=failed#retention`);
  }
  await audit("deletion_requested", user);
  await clearSessionCookie();
  redirect(`/${locale}/login?notice=deletion-requested`);
}
