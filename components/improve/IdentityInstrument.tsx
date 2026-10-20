import { useTranslations } from "next-intl";

import { StatusMark } from "@/components/ui/StatusMark";

interface IdentityInstrumentProps {
  readonly name: string;
  readonly verified: boolean;
}

/**
 * The right column's Identity (feature-specs/34 § 6): the contributor's name with `verified`, and what the adjudicator
 * is told of it — verified or not, and nothing else (32 § 7.1, invariant 12). The screen's `sso · 18 Mar 2026` is not
 * drawn: no column holds when an identity was verified.
 */
export function IdentityInstrument({ name, verified }: IdentityInstrumentProps) {
  const t = useTranslations("improve.suggest.identity");
  return (
    <section className="inst" aria-labelledby="identity-title">
      <div className="inst-h">
        <h2 className="t" id="identity-title">
          {t("title")}
        </h2>
      </div>
      <div className="inst-b col identity-body">
        <div className="between">
          <span className="small">{name}</span>
          <StatusMark tone={verified ? "ok" : "warn"}>{t(verified ? "verified" : "unverified")}</StatusMark>
        </div>
        <p className="help">{t("help")}</p>
      </div>
    </section>
  );
}
