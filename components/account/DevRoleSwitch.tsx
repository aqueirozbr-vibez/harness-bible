import { useTranslations } from "next-intl";

import { devRoleHref } from "@/lib/auth/signIn";
import type { Locale } from "@/lib/i18n/routing";
import { RoleSchema, type Role } from "@/lib/schemas/auth";

interface DevRoleSwitchProps {
  readonly email: string;
  readonly role: Role;
  readonly locale: Locale;
  /** Id of the visible label that names the group. */
  readonly labelledBy: string;
}

/**
 * The development account's role switch (feature-specs/29 § 16): a segment per role, each the development sign-in
 * as this account in that role, which comes back to this page. Rendered only where the development provider is on.
 *
 * The segments are plain anchors and not `Link`s on purpose: a link that is prefetched is followed, and following
 * one of these changes the account's role and signs its other sessions out.
 */
export function DevRoleSwitch({ email, role, locale, labelledBy }: DevRoleSwitchProps) {
  const t = useTranslations("account.role");
  return (
    <div className="seg-links" role="group" aria-labelledby={labelledBy}>
      {RoleSchema.options.map((option) => (
        <a key={option} href={devRoleHref(email, option, locale)} aria-current={option === role ? "true" : undefined}>
          {t(option)}
        </a>
      ))}
    </div>
  );
}
