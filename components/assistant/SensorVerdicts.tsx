"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";

import { StatusMark } from "@/components/ui/StatusMark";
import { verdictSummary, type AnswerView } from "@/lib/assistant/turns";
import { shortHash } from "@/lib/ledger/hash";

/*
 * What was checked, in the reader's own words (feature-specs/16 § 5.7). The box is the answer's receipt: five rows,
 * each a sensor, its own sentence from the row, and its mark. The current turn opens expanded and an earlier turn
 * collapsed with its score on the toggle, because a reader reads the newest answer and audits the older ones.
 *
 * The footer is the ledger line: the trace id the span carries and the record's first twelve hex characters, so the
 * answer on screen can be matched to the record that proves it (feature-specs/14 § 6).
 */

const TONE: Readonly<Record<string, "ok" | "warn" | "fail" | "mute">> = { PASS: "ok", WARN: "warn", FAIL: "fail", NA: "mute" };
const MARK: Readonly<Record<string, "pass" | "warn" | "fail" | "info">> = { PASS: "pass", WARN: "warn", FAIL: "fail", NA: "info" };

interface SensorVerdictsProps {
  readonly answer: AnswerView;
  /** Open or collapsed: the dock owns it, so a log row can open a turn's box from the rail (feature-specs/17 § 5.2). */
  readonly open: boolean;
  readonly onToggle: () => void;
}

export function SensorVerdicts({ answer, open, onToggle }: SensorVerdictsProps) {
  const t = useTranslations("assistant.dock");
  const tv = useTranslations("assistant.verdict");
  const id = useId();
  const summary = verdictSummary(answer.verdicts);
  /* A walk's receipt is its own check (feature-specs/18 § 4): the toggle reads the derive row — `derive output matched
     · 4 of 4` — rather than a count that includes claims the walk never shows; the five rows beneath stand as they are. */
  const derive = answer.walk === null ? undefined : answer.verdicts.find((verdict) => verdict.sensor === "derive");

  return (
    <section className="box verdicts">
      <button
        type="button"
        className="between verdicts-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className="row gap-s2">
          <span className="mono verdicts-glyph" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="label">{t("verdicts")}</span>
        </span>
        <span className="row verdicts-summary">
          {answer.grounded === null ? null : <span className="meta">{t("groundedShort", { score: answer.grounded.toFixed(2) })}</span>}
          <StatusMark tone={derive === undefined ? summary.tone : (TONE[derive.verdict] ?? "mute")}>{derive === undefined ? t("pass", { n: summary.passed, m: summary.total }) : derive.detail}</StatusMark>
        </span>
      </button>
      {open ? (
        <>
          <dl id={id} className="verdicts-grid">
            {answer.verdicts.map((verdict) => (
              <div key={verdict.sensor} className="contents">
                <dt className="mono">{tv(verdict.sensor)}</dt>
                <dd>{verdict.detail}</dd>
                <dd>
                  <StatusMark tone={TONE[verdict.verdict] ?? "mute"}>{t(`mark.${MARK[verdict.verdict] ?? "info"}`)}</StatusMark>
                </dd>
              </div>
            ))}
          </dl>
          <div className="inst-f verdicts-foot">
            <span>{t("log", { trace: answer.traceId ?? "" })}</span>
            {answer.ledger === null ? null : (
              <span className="hash">
                {/* A turn read back from its row carries its own hash; the chain's previous one is the event's. */}
                {answer.ledger.prevHash === null
                  ? t("hashOnly", { h: shortHash(answer.ledger.hash) })
                  : t("hash", { h: shortHash(answer.ledger.hash), p: shortHash(answer.ledger.prevHash) })}
              </span>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
