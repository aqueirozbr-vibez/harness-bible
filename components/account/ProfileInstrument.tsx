import { useTranslations } from "next-intl";

import type { DevStanding } from "@/components/account/AccountPage";
import { DevRoleSwitch } from "@/components/account/DevRoleSwitch";
import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { PART_ROMAN } from "@/components/reader/PartGrid";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { AccountData } from "@/lib/schemas/auth";

import { updateProfile } from "@/app/[lang]/account/actions";

interface ProfileInstrumentProps {
  readonly data: AccountData;
  readonly locale: Locale;
  readonly nameError: boolean;
  /** The development provider is on: the role is a switch, not a fact, with what it can do (feature-specs/29 § 16, § 17); null where it is off. */
  readonly dev: DevStanding | null;
}

/**
 * Display name (editable), e-mail and role (read-only, or a switch for a development account) (feature-specs/08 § 6.3).
 * Under a development account's switch, one line says what its role can do now: what a contributor's needs, a verified
 * identity, and a curator's, parts on the roster, or that the role's own pages are not built yet (29 § 17).
 */
export function ProfileInstrument({ data, locale, nameError, dev }: ProfileInstrumentProps) {
  const t = useTranslations("account");
  const { user, identities } = data;
  const from = identities.length === 0 ? null : identities[identities.length - 1].provider;
  /* P4 reads as P3, as the reader folds it (lib/db/content.ts). */
  const parts = dev === null ? "" : [...new Set(dev.parts.map((part) => (part === "P4" ? PART_ROMAN.P3 : PART_ROMAN[part])))].join(", ");
  const can =
    dev === null
      ? null
      : (user.role === "CONTRIBUTOR" || user.role === "CURATOR") && !dev.verified
        ? t("devRole.unverified", { role: t(`role.${user.role}`) })
        : user.role === "CURATOR"
          ? parts === ""
            ? t("devRole.CURATOR_NONE")
            : t("devRole.CURATOR", { parts })
          : t(`devRole.${user.role}`);
  return (
    <InstrumentPanel label={t("profile.label")} timestamp={t("profile.since", { date: formatDate(user.createdAt, locale) })} className="account-inst">
      <form action={updateProfile} className="col gap-s4">
        <input type="hidden" name="locale" value={locale} />
        <Field label={t("profile.displayName")} htmlFor="displayName" error={nameError ? t("profile.nameError") : undefined}>
          <input id="displayName" name="displayName" className="input" defaultValue={user.displayName} maxLength={60} required aria-invalid={nameError || undefined} />
        </Field>
        <dl className="kv kv-prose">
          <dt>{t("profile.email")}</dt>
          <dd>
            {user.email}
            {from !== null ? <span className="meta"> · {t("profile.emailFrom", { provider: t(`provider.${from}`) })}</span> : null}
          </dd>
          <dt id="profile-role">{t("profile.role")}</dt>
          {dev !== null ? (
            /* A development account's role is its own to switch (29 § 16); `dev` is the provider's tag, as on the sign-in page. */
            <dd className="col dev-role">
              <div className="row">
                <DevRoleSwitch email={user.email} role={user.role} locale={locale} labelledBy="profile-role" />
                <span className="meta">dev</span>
              </div>
              <p className="help">{can}</p>
            </dd>
          ) : (
            <dd>
              {t(`role.${user.role}`)}
              <span className="meta"> · {t("profile.roleNote")}</span>
            </dd>
          )}
        </dl>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button type="submit" size="sm">
            {t("profile.save")}
          </Button>
        </div>
      </form>
    </InstrumentPanel>
  );
}
