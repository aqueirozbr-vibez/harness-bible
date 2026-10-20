import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";

import { AccountPage, type AccountError, type AccountNotice } from "@/components/account/AccountPage";
import { TopBar } from "@/components/chrome/TopBar";
import { devProviderEnabled } from "@/lib/auth/devProvider";
import { keycloakConfigured } from "@/lib/auth/oidc";
import { getSession } from "@/lib/auth/session";
import { signInHref } from "@/lib/auth/signIn";
import { budgetView } from "@/lib/budget/view";
import { getAccountData } from "@/lib/db/account";
import { conversationStats, TEXT_RETENTION_DAYS } from "@/lib/db/assistant";
import { budgetFacts } from "@/lib/db/budget";
import { timed } from "@/lib/db/timing";
import { env } from "@/lib/env";
import { LocaleSchema } from "@/lib/i18n/routing";

/* The user's own settings; per request; signed out → the sign-in page with `next` (feature-specs/08 § 3). */
export const dynamic = "force-dynamic";

interface AccountRouteProps {
  readonly params: Promise<{ lang: string }>;
  readonly searchParams: Promise<{ saved?: string; revoked?: string; linked?: string; unlinked?: string; switched?: string; error?: string }>;
}

const ERRORS: ReadonlySet<string> = new Set(["linked-elsewhere", "last-identity", "session", "failed", "name", "confirm"]);

export async function generateMetadata({ params }: AccountRouteProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "account" });
  return { title: t("metaTitle"), robots: { index: false }, alternates: { languages: { en: "/en/account", pt: "/pt/account" } } };
}

export default async function AccountRoute({ params, searchParams }: AccountRouteProps) {
  const locale = LocaleSchema.parse((await params).lang);
  setRequestLocale(locale);
  const user = await getSession();
  if (user === null) redirect(signInHref(locale, `/${locale}/account`));
  const query = await searchParams;
  const { result: data, ms: loadedMs } = await timed(() => getAccountData(user));
  /* The retention instrument's evidence (feature-specs/21 § 3.2): how many conversations, and until when the oldest text is kept. */
  const stats = await conversationStats(user);
  const retention = { conversations: stats.conversations, keptUntil: stats.oldestTextAt === null ? null : new Date(stats.oldestTextAt.getTime() + TEXT_RETENTION_DAYS * 86_400_000).toISOString() };

  /* The budget meter (feature-specs/21 § 4): the month's rows of whoever pays for this reader's calls — the
     organisation, or the reader on an individual account (11 § 3.4) — and the cap. Read from the database; the
     page never asks the gateway (invariant 6). */
  const now = new Date();
  const principal = user.organisationId === null ? { userId: user.id } : { organisationId: user.organisationId };
  const budget = budgetView(await budgetFacts(principal, now, env.INDIVIDUAL_TOKEN_CAP === undefined ? null : Number(env.INDIVIDUAL_TOKEN_CAP)), now);
  /* The curator roster and the audit export's form are on Book management since 2026-10-12, for curators and
     organisation admins (feature-specs/47): the head links there for them. */

  const devProvider = devProviderEnabled();
  let notice: AccountNotice | null = null;
  if (query.saved === "profile" || query.saved === "preferences") notice = { kind: "saved" };
  else if (query.revoked !== undefined) notice = { kind: "revoked" };
  else if (query.linked === "google" || query.linked === "github") notice = { kind: "linked", provider: query.linked };
  else if (query.unlinked === "google" || query.unlinked === "github") notice = { kind: "unlinked", provider: query.unlinked };
  /* The role switch's return (29 § 17): said only of the role the session now has. */
  else if (devProvider && query.switched === user.role) notice = { kind: "role", role: user.role };

  return (
    <>
      <TopBar locale={locale} current="account" release={{ id: data.release.id, sha: data.release.gitSha }} session={user} compact />
      <AccountPage data={data} retention={retention} budget={budget} locale={locale} loadedMs={loadedMs} providersConfigured={keycloakConfigured()} dev={devProvider ? { verified: user.identityVerified, parts: user.parts } : null} notice={notice} error={query.error !== undefined && ERRORS.has(query.error) ? (query.error as AccountError) : null} />
    </>
  );
}
