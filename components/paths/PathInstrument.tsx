import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { PathSequence } from "@/components/paths/PathSequence";
import { ResetPathDialog } from "@/components/paths/ResetPathDialog";
import { Button } from "@/components/ui/Button";
import { Meter } from "@/components/ui/Meter";
import type { Locale } from "@/lib/i18n/routing";
import type { PathView } from "@/lib/schemas/paths";

interface PathInstrumentProps {
  readonly path: PathView;
  readonly locale: Locale;
  readonly signedIn: boolean;
  /** This path is the most recently updated one: its Resume is the primary button. */
  readonly active: boolean;
  readonly startAction: (formData: FormData) => Promise<void>;
  readonly resetAction: (formData: FormData) => Promise<void>;
}

/** One path: audience rows, progress, the sequence and the Start / Resume footer (feature-specs/05 § 6.3). */
export function PathInstrument({ path, locale, signedIn, active, startAction, resetAction }: PathInstrumentProps) {
  const t = useTranslations("paths");
  const tn = useTranslations("home.continue.pathName");
  const name = tn(path.key);
  const time = (minutes: number): string => (minutes >= 60 ? t("path.timeHours", { h: Math.floor(minutes / 60), m: minutes % 60 }) : t("path.timeMin", { m: minutes }));
  const firstHref = path.groups[0]?.stops[0]?.href ?? `/${locale}/paths/${path.key}`;
  const complete = path.resume !== null && path.done >= path.total;

  let action: ReactNode;
  if (!signedIn) {
    action = <Button href={firstHref}>{t("path.start")}</Button>;
  } else if (path.resume === null) {
    action = (
      <form action={startAction}>
        <input type="hidden" name="path" value={path.key} />
        <input type="hidden" name="locale" value={locale} />
        <Button type="submit">{t("path.start")}</Button>
      </form>
    );
  } else {
    action = (
      <div className="row gap-s2">
        <ResetPathDialog path={path.key} locale={locale} name={name} action={resetAction} />
        {complete ? (
          <Button href={firstHref}>{t("path.again")}</Button>
        ) : (
          <Button href={path.resume.href} variant={active ? "primary" : "default"}>
            {t("path.resume", { id: path.resume.sectionId })}
          </Button>
        )}
      </div>
    );
  }

  return (
    <InstrumentPanel
      label={t("path.label", { name })}
      ariaLabel={t("path.aria", { name })}
      meta={[
        { key: "version", node: path.version },
        { key: "count", node: t(`path.${path.stopNoun}`, { n: path.total }) },
      ]}
      timestamp={time(path.minutes)}
      className="path-inst"
      footer={
        <>
          <span className="small muted">{t("path.footer")}</span>
          {action}
        </>
      }
      footerClassName="path-foot"
    >
      <div className="col path-body">
        <dl className="kv kv-prose">
          <dt>{t("path.who")}</dt>
          <dd>{t(`audience.${path.key}.who`)}</dd>
          <dt>{t("path.use")}</dt>
          <dd>{t(`audience.${path.key}.use`)}</dd>
          <dt>{t("path.must")}</dt>
          <dd>{t(`audience.${path.key}.must`)}</dd>
        </dl>
        {signedIn ? (
          <div className="col rt path-progress">
            <div className="between">
              <span className="flabel">{t("path.progress")}</span>
              <span className="meta">
                {t("path.of", { done: path.done, total: path.total })} · {t("path.left", { time: time(path.minutesLeft) })}
              </span>
            </div>
            <Meter value={path.done} max={path.total} tone="ver" label={t("path.meter", { name })} />
            {path.outdated ? <span className="meta">{t("path.updated", { version: path.version })}</span> : null}
          </div>
        ) : null}
        <PathSequence path={path} name={name} />
      </div>
    </InstrumentPanel>
  );
}
