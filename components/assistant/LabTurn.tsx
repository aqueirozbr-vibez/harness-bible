"use client";

import { useTranslations } from "next-intl";

import { AnswerBody } from "@/components/assistant/AnswerBody";
import { Cite } from "@/components/ui/Cite";
import { DeriveLink } from "@/components/ui/DeriveLink";
import { refHref, type RefBase } from "@/lib/assistant/links";
import type { AnswerView } from "@/lib/assistant/turns";
import { runtimeText } from "@/lib/labs/pseudoSections";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { cn } from "@/lib/utils";

/*
 * A lab answer's body (feature-specs/19 § 6.2): the lab's facts as a key–value list, the figures the lab checks as a
 * diff table with the book's value on the left (ui-context § 9.3), then the claims as explain renders them. The
 * facts and the table are the workers' (`final.modeResult.lab`), computed from the same pseudo-section the model
 * read, so the screen and the model saw one thing (invariant 14).
 */

interface LabTurnProps {
  readonly answer: AnswerView;
  readonly basePath: RefBase;
  readonly locale: Locale;
}

export function LabTurn({ answer, basePath, locale }: LabTurnProps) {
  const t = useTranslations("assistant.lab");
  const lab = answer.lab;
  if (lab === null) return <AnswerBody answer={answer} basePath={basePath} />;
  const n = String(lab.lab.number).padStart(2, "0");
  const divergent = lab.lab.figures.some((figure) => figure.verdict === "diverge");

  return (
    <div className="labturn">
      <dl className="kv">
        <dt>{t("kvLab")}</dt>
        <dd>{`Lab ${n} · ${lab.lab.title.toLowerCase()}`}</dd>
        <dt>{t("kvRun")}</dt>
        <dd>{lab.lab.verdict === null ? t("notYet") : `${lab.lab.verdict} · ${t("ci")}${lab.lab.checkedAt === null ? "" : ` · ${formatDate(new Date(lab.lab.checkedAt), locale)}`}`}</dd>
        <dt>{t("kvRuntime")}</dt>
        <dd>{lab.lab.expectedRuntimeS === null ? t("notDeclared") : runtimeText(lab.lab.expectedRuntimeS)}</dd>
        <dt>{t("kvModel")}</dt>
        <dd>{lab.lab.declaresModelCalls ? t("declared") : t("none")}</dd>
      </dl>

      {lab.reproduces.length === 0 ? null : <p className="small">{lab.reproduces}</p>}

      {lab.lab.figures.length === 0 ? null : (
        <div className="scroll">
          <table className="tbl lab-figures">
            <caption className="cap">{t("figures", { n })}</caption>
            <thead>
              <tr>
                <th scope="col">{t("thFigure")}</th>
                <th scope="col" className="n">
                  {t("thChapter")}
                </th>
                <th scope="col" className="n">
                  {t("thRun")}
                </th>
                <th scope="col">—</th>
              </tr>
            </thead>
            <tbody>
              {lab.lab.figures.map((figure) => (
                <tr key={figure.figureId} className={cn(figure.verdict === "diverge" && "row-div")}>
                  <td>
                    <Cite href={refHref(basePath, figure.sectionId)} figureId={figure.figureId}>
                      {figure.figureId}
                    </Cite>
                  </td>
                  <td className="n">
                    <span className="fig-der mono">{figure.chapterValue}</span> <DeriveLink line={figure.line} title={t("deriveTitle", { line: figure.line })} />
                  </td>
                  <td className="n">{figure.runValue === null ? "—" : String(figure.runValue)}</td>
                  <td className={cn("m", figure.verdict === "match" && "d-match", figure.verdict === "diverge" && "d-div")}>{figure.verdict === "match" ? t("match") : figure.verdict === "diverge" ? t("diverge") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {divergent && lab.divergingMeans !== null && lab.divergingMeans.length > 0 ? <p className="small muted">{lab.divergingMeans}</p> : null}

      <div className="turn-body">
        <AnswerBody answer={answer} basePath={basePath} />
      </div>
    </div>
  );
}
