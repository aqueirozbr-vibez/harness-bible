import { useTranslations } from "next-intl";

import { DeviceControls } from "@/components/account/DeviceControls";
import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import type { Locale } from "@/lib/i18n/routing";
import type { AccountData } from "@/lib/schemas/auth";

import { updatePreferences } from "@/app/[lang]/account/actions";

interface PreferencesInstrumentProps {
  readonly data: AccountData;
  readonly locale: Locale;
}

/** Edition language (account), theme and shortcuts (device) (feature-specs/08 § 6.3). */
export function PreferencesInstrument({ data, locale }: PreferencesInstrumentProps) {
  const t = useTranslations("account.prefs");
  return (
    <InstrumentPanel label={t("label")} meta={[{ key: "scope", node: t("meta") }]} className="account-inst">
      <div className="col gap-s3">
        <div className="between pref-row">
          <span className="flabel" id="pref-language">
            {t("language")}
          </span>
          <span className="row" style={{ gap: 10 }}>
            <form action={updatePreferences} className="seg" role="group" aria-labelledby="pref-language">
              <input type="hidden" name="locale" value={locale} />
              <button type="submit" name="edition" value="en" aria-pressed={data.user.locale === "en"}>
                EN
              </button>
              <button type="submit" name="edition" value="pt" aria-pressed={data.user.locale === "pt"}>
                PT
              </button>
            </form>
            <span className="meta">{t("scopeAccount")}</span>
          </span>
        </div>
        <DeviceControls />
      </div>
    </InstrumentPanel>
  );
}
