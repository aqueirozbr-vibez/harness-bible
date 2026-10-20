import { useTranslations } from "next-intl";
import { Fragment } from "react";

import { Meter } from "@/components/ui/Meter";
import { formatClock } from "@/lib/i18n/format";
import { bandOf, computedRowsOf, type Band } from "@/lib/improve/scoreView";
import type { EvidenceItemView, SuggestionScoring, SuggestionView } from "@/lib/schemas/suggestions";
import { cn } from "@/lib/utils";

interface ScoreInstrumentProps {
  readonly rubricVersion: string;
  /** Null until an item is graded. */
  readonly scoring: SuggestionScoring | null;
  readonly thresholds: SuggestionView["thresholds"];
  readonly items: ReadonlyArray<EvidenceItemView>;
  /** When the column last drew a read of the draft; null as the page loaded. */
  readonly at: Date | null;
}

const BAND_CLASS: Readonly<Record<Band, string>> = { under: "text-fail", between: "text-warn", accepted: "text-ver" };
const BAND_TONE: Readonly<Record<Band, "fail" | "warn" | "ver">> = { under: "fail", between: "warn", accepted: "ver" };
const pad = (n: number): string => String(n).padStart(2, "0");
/** How near an end of the scale, in points, a tick's label stops being centred on its tick. */
const NEAR_END = 12;
const edgeOf = (at: number): string | false => (at < NEAR_END ? "is-start" : at > 100 - NEAR_END ? "is-end" : false);

/**
 * The right column's Score instrument, as the Improve-Suggest screen draws it (feature-specs/34 § 6): the big number
 * in the colour of where it stands, `accept ≥` and `floor`, the meter with its two ticks and its accessible sentence,
 * and "how it is computed": the strongest item, the corroboration, each other item alone or grading, and the total
 * line. Every number is the read's; the page computes none (architecture § 3.1).
 */
export function ScoreInstrument({ rubricVersion, scoring, thresholds, items, at }: ScoreInstrumentProps) {
  const t = useTranslations("improve.suggest.score");
  const te = useTranslations("improve.suggest.evidence");
  const score = scoring?.score ?? null;
  const band = score === null ? null : bandOf(score, thresholds);
  const { acceptAt, floorAt } = thresholds;
  const rows = scoring === null ? [] : computedRowsOf(scoring, items);
  const strongest = rows.find((row) => row.kind === "strongest");
  const corroboration = rows.find((row) => row.kind === "corroboration");
  const line = (key: string, term: string, value: string, faint = false) => (
    <Fragment key={key}>
      <dt>{term}</dt>
      <dd className={cn(faint && "faint")}>{value}</dd>
    </Fragment>
  );
  return (
    <section className="inst" aria-labelledby="score-title">
      <div className="inst-h">
        <h2 className="t" id="score-title">
          {t("title")}
        </h2>
        <span className="sep">·</span>
        <span>{t("rubric", { version: rubricVersion })}</span>
        <span className="ts">{at === null ? t("live") : t("liveAt", { time: formatClock(at) })}</span>
      </div>
      <div className="inst-b col score-body">
        <div className="row score-head">
          <span className={cn("bignum", band !== null && BAND_CLASS[band])}>{score ?? "—"}</span>
          {acceptAt !== null && floorAt !== null ? (
            <div className="col score-thresholds">
              <span className="meta">{t("accept", { n: acceptAt })}</span>
              <span className="meta faint">{t("floor", { n: floorAt })}</span>
            </div>
          ) : (
            <span className="meta score-thresholds">{t("curator")}</span>
          )}
        </div>
        {acceptAt !== null && floorAt !== null ? (
          <div className="col score-scale">
            <Meter value={score ?? 0} label={t("meter", { score: score ?? 0, accept: acceptAt, floor: floorAt })} tone={band === null ? "ink" : BAND_TONE[band]} marks={[{ at: floorAt }, { at: acceptAt, ok: true }]} className="score-meter" />
            {/* A tick's label near an end starts or ends at its tick, and the end's own number gives way to it; a floor at the acceptance is one label. */}
            <div className="mono score-ticks" aria-hidden="true">
              {floorAt >= NEAR_END ? <span className="cap score-tick-start">0</span> : null}
              {floorAt !== acceptAt ? (
                <span className={cn("cap text-fail score-tick", edgeOf(floorAt))} style={{ left: `${String(floorAt)}%` }}>
                  {t("floor", { n: floorAt })}
                </span>
              ) : null}
              <span className={cn("cap text-ink score-tick", edgeOf(acceptAt))} style={{ left: `${String(acceptAt)}%` }}>
                {t("scaleAccept", { n: acceptAt })}
              </span>
              {acceptAt <= 100 - NEAR_END ? <span className="cap score-tick-end">100</span> : null}
            </div>
          </div>
        ) : null}
        <div className="rt col score-how">
          <span className="cap">{t("how")}</span>
          <p className="small">{t("rule")}</p>
          {scoring === null ? (
            <p className="small muted">{t("none")}</p>
          ) : (
            <dl className="kv score-rows">
              {rows.map((row) =>
                row.kind === "strongest" ? (
                  line("strongest", t("strongest", { n: pad(row.ordinal), tier: row.tier }), String(row.score))
                ) : row.kind === "corroboration" ? (
                  line("corroboration", t("corroboration", { n: pad(row.ordinal), tier: row.tier }), `+${String(row.bonus)}`)
                ) : row.kind === "alone" ? (
                  line(`alone-${String(row.ordinal)}`, t("alone", { n: pad(row.ordinal) }), t("notAdded", { score: row.score }), true)
                ) : (
                  line(`grading-${String(row.ordinal)}`, t("item", { n: pad(row.ordinal) }), te("grading"), true)
                ),
              )}
            </dl>
          )}
          {strongest !== undefined && strongest.kind === "strongest" ? (
            <div className="rt between score-total">
              <span className="meta">{t("total")}</span>
              <span className="meta score-sum">{corroboration !== undefined && corroboration.kind === "corroboration" ? t("sum", { strongest: strongest.score, bonus: corroboration.bonus, score: score ?? 0 }) : String(score ?? 0)}</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
