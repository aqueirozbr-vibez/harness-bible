"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { onDraftSave, type DraftClass } from "@/lib/hooks/draftSave";

interface ClassPanelProps {
  /** The class as the draft's read computed it, with whether recency applies (30 § 3.4). */
  readonly draftClass: DraftClass;
  readonly rubricVersion: string;
}

/** The two rules a proposal can meet (30 § 4.2): the others are the anchor's and the kind's, fixed with the draft. */
const PROPOSAL_REASONS = new Set(["SAFETY_OT", "NEW_SOURCE_TIER"]);

/**
 * The Change class panel (feature-specs/34 § 5; the Improve-Suggest screen's left column): the class the server
 * computed from the anchor and the proposal (30 § 4.2), its thresholds, whether recency applies and whether a curator
 * decides. Every value is the server's: the draft's read, then each save's answer. A save that moves the class says
 * why in one line, in a status region that exists before it is filled, so that a screen reader hears it.
 *
 * The line names the rule when the proposal moved the class to the curator (rules 3 and 4), and the return when it
 * moved it back. A save also reclassifies by the release's anchor (31 § 4), so a class can move for a reason the
 * proposal is not: then the line says only where the class went.
 */
export function ClassPanel({ draftClass, rubricVersion }: ClassPanelProps) {
  const t = useTranslations("improve.suggest.class");
  const tr = useTranslations("rubric.thresholds");
  const [shown, setShown] = useState<{ readonly current: DraftClass; readonly from: DraftClass | null }>({ current: draftClass, from: null });

  useEffect(
    () =>
      onDraftSave((detail) => {
        if (detail.state !== "saved") return;
        const next = detail.draftClass;
        /* A save that leaves the class where it was may still change whether recency applies: the panel follows, with no line. */
        setShown((was) => (was.current.changeClass === next.changeClass && was.current.curatorReason === next.curatorReason ? { current: next, from: was.from } : { current: next, from: was.current }));
      }),
    [],
  );

  const { changeClass, curatorReason, thresholds, fastMoving } = shown.current;
  const className = tr(`class.${changeClass}`);
  const back = shown.from !== null && shown.from.curatorReason !== null && PROPOSAL_REASONS.has(shown.from.curatorReason);
  const why =
    shown.from === null
      ? null
      : curatorReason !== null && PROPOSAL_REASONS.has(curatorReason)
        ? t(`moved.${curatorReason as "SAFETY_OT" | "NEW_SOURCE_TIER"}`)
        : curatorReason !== null
          ? t("moved.curator", { reason: t(`reason.${curatorReason}`) })
          : back
            ? t("moved.other", { class: className })
            : t("moved.plain", { class: className });
  return (
    <InstrumentPanel label={t("label")} meta={[{ key: "detected", node: t("detected") }]} timestamp={t("rubric", { version: rubricVersion })} footer={<span>{t("footer")}</span>} className="class-panel">
      <p className="small class-panel-name">{className}</p>
      <dl className="kv">
        <dt>{t("accept")}</dt>
        <dd>{thresholds.acceptAt ?? tr("noScore")}</dd>
        <dt>{t("floor")}</dt>
        <dd>{thresholds.floorAt ?? tr("noScore")}</dd>
        <dt>{t("recency")}</dt>
        <dd>{t(fastMoving ? "recencyApplies" : "recencyNone")}</dd>
        <dt>{t("curator")}</dt>
        <dd>{curatorReason === null ? t("curatorNo") : t("curatorYes", { reason: t(`reason.${curatorReason}`) })}</dd>
      </dl>
      <p className="small class-panel-moved" role="status">
        {why}
      </p>
    </InstrumentPanel>
  );
}
