import { useTranslations } from "next-intl";
import Link from "next/link";

import { Notice } from "@/components/ui/Notice";

interface AnchorChangedProps {
  /** The anchored text as the draft recorded it. */
  readonly was: string;
  /** As the current release has it; null when the release no longer has the anchor. */
  readonly now: string | null;
  /** Step 1 for the same anchor: a different text is a different suggestion. */
  readonly chooseHref: string;
  /** The edition's language, which both texts are in (WCAG 3.1.2). */
  readonly contentLang: "en" | "pt";
}

/**
 * The state of § 7 where the draft's anchor changed in a new release (feature-specs/34 § 7; unit 51e): a notice with
 * the text the draft recorded and the text the release has now, or that it has none, and `Choose an anchor`. The
 * `ANCHOR_EXISTS` sensor would refuse the draft as it stands.
 */
export function AnchorChanged({ was, now, chooseHref, contentLang }: AnchorChangedProps) {
  const t = useTranslations("improve.suggest.anchorChanged");
  const ts = useTranslations("improve.suggest.submit");
  return (
    <Notice title={t("title")} className="anchor-changed">
      <p>{now === null ? t("gone") : t("body")}</p>
      <div className="col anchor-changed-texts">
        <span className="cap">{t("was")}</span>
        <p className="tex anchor-changed-text" tabIndex={0} aria-label={t("was")} lang={contentLang}>
          {was}
        </p>
        {now !== null ? (
          <>
            <span className="cap">{t("now")}</span>
            <p className="tex anchor-changed-text" tabIndex={0} aria-label={t("now")} lang={contentLang}>
              {now}
            </p>
          </>
        ) : null}
      </div>
      <Link className="btn btn-sm" href={chooseHref}>
        {ts("chooseAnchor")}
      </Link>
    </Notice>
  );
}
