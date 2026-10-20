import { useTranslations } from "next-intl";

import { StatusBar } from "@/components/chrome/StatusBar";
import { PathInstrument } from "@/components/paths/PathInstrument";
import { PathsHero } from "@/components/paths/PathsHero";
import { YourMarks } from "@/components/paths/YourMarks";
import { ErrorBox } from "@/components/ui/ErrorBox";
import { formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { PathKey } from "@/lib/paths/definitions";
import type { PathsData } from "@/lib/schemas/paths";
import { cn } from "@/lib/utils";

export type PathsActionError = "session" | "start" | "reset";

interface PathsPageProps {
  readonly data: PathsData;
  readonly locale: Locale;
  readonly loadedMs: number;
  /** Render one path full width (`/[lang]/paths/[path]`). */
  readonly only?: PathKey;
  readonly error?: PathsActionError;
  readonly startAction: (formData: FormData) => Promise<void>;
  readonly resetAction: (formData: FormData) => Promise<void>;
}

/** The reading-paths page: hero and marks, the three instruments, status bar (feature-specs/05 § 6). */
export function PathsPage({ data, locale, loadedMs, only, error, startAction, resetAction }: PathsPageProps) {
  const t = useTranslations("paths");
  const th = useTranslations("home.statusbar");
  const tn = useTranslations("home.continue.pathName");
  const paths = only === undefined ? data.paths : data.paths.filter((p) => p.key === only);

  return (
    <>
      <main className="paths">
        <div className="paths-head">
          <PathsHero releaseId={data.release.id} />
          <YourMarks marks={data.marks} locale={locale} />
        </div>
        {error !== undefined ? <ErrorBox title={t("error.title")}>{t(`error.${error}`)}</ErrorBox> : null}
        <div className={cn("paths-grid", only !== undefined && "paths-grid-one")}>
          {paths.map((path) => (
            <PathInstrument key={path.key} path={path} locale={locale} signedIn={data.signedIn} active={data.active?.key === path.key} startAction={startAction} resetAction={resetAction} />
          ))}
        </div>
      </main>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{t("status.count", { n: data.paths.length })}</span>
        <span className="desktop-only">{th("lang", { lang: locale.toUpperCase(), src: data.sourceLang })}</span>
        <span className="desktop-only">{th("release", { id: data.release.id })}</span>
        {data.active !== null ? <span>{t("status.active", { path: tn(data.active.key).toLowerCase(), done: data.active.done, total: data.active.total, id: data.active.resume })}</span> : null}
      </StatusBar>
    </>
  );
}
