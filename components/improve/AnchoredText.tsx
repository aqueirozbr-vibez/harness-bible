import { useTranslations } from "next-intl";
import { Fragment } from "react";

import { TierChip } from "@/components/improve/TierChip";
import { StatusMark } from "@/components/ui/StatusMark";
import { Xref } from "@/components/ui/Xref";
import type { StartAnchor } from "@/lib/db/suggestStart";

interface AnchoredTextProps {
  /** The anchor's section, which a section's anchored text names. */
  readonly home: { readonly id: string; readonly title: string };
  /** The language of the sections' titles: the edition's. The anchored text is the source edition's, EN. */
  readonly contentLang: "en" | "pt";
  /** The chapter's version the text is read at. */
  readonly version: string;
  readonly anchor: StartAnchor;
}

/**
 * The anchored text at its version (feature-specs/34 § 4, § 5; the Improve-Suggest screen's blockquote): a figure's
 * or a row's text with its tier chip and fast-moving mark, a section by its title, and the sections that read it.
 * Step 1 shows what a draft would store; the edit page what the draft stores.
 */
export function AnchoredText({ home, contentLang, version, anchor }: AnchoredTextProps) {
  const t = useTranslations("improve.suggest");
  const tt = useTranslations("search.tier");
  const isSection = anchor.kind === "SECTION";
  return (
    <section className="col anchor-text" aria-label={t("anchoredLabel")}>
      <span className="cap">{t(isSection ? "anchoredSection" : "anchoredText", { version })}</span>
      <blockquote className="box anchor-quote">
        {isSection ? <p lang={contentLang}>{t("sectionLabel", { id: home.id, title: home.title })}</p> : <p lang="en">{anchor.text}</p>}
        {!isSection && (anchor.tier !== null || anchor.fastMoving) ? (
          <div className="row anchor-quote-marks">
            <TierChip tier={anchor.tier} scenario={anchor.scenario} word={anchor.tier === null ? undefined : t("chip", { tier: tt(anchor.tier), id: anchor.id })} />
            {anchor.fastMoving ? anchor.stale ? <StatusMark tone="warn">{t("fastMovingStale")}</StatusMark> : <span className="meta">{t("fastMoving")}</span> : null}
          </div>
        ) : null}
      </blockquote>
      {anchor.readBy.length > 0 ? (
        <p className="help">
          {t("readBy.lead")}{" "}
          {anchor.readBy.map((reader, index) => (
            <Fragment key={reader.section}>
              {index > 0 ? ` ${t("readBy.and")} ` : null}
              <Xref href={reader.href}>{reader.section}</Xref> <span lang={contentLang}>{reader.title}</span>
            </Fragment>
          ))}
          {t("readBy.end")}
        </p>
      ) : null}
    </section>
  );
}
