"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { StatusMark } from "@/components/ui/StatusMark";
import type { Aid } from "@/lib/aids/schema";
import { aidKey, stepState } from "@/lib/assistant/walk";
import { ASSISTANT_STATUS_EVENT, type AssistantStatusDetail } from "@/lib/hooks/citedPassages";
import { cn } from "@/lib/utils";

/*
 * The reading column's side of a walk (feature-specs/18 § 5, § 7): under the section head, the `walking` band in the
 * run tone — `The assistant is walking this aid with your inputs. Step 2 of 4.` — and the aid's steps as a tree whose
 * `done` and `now` marks follow the dock's strip. The dock owns the step and lives in another tree, so it sends it
 * on the same event the status bar listens to; nothing here is computed, and the section's own prose stands beneath.
 *
 * The screen's configuration table and its walk prose are not in the book (spec 18 § 11, D5): the column shows the
 * band, the tree and then the section as the release prints it.
 */

interface WalkingBandProps {
  /** The chapter's aids, so the tree has its titles; an aid the dock names that is not here renders the band alone. */
  readonly aids: ReadonlyArray<Aid>;
}

export function WalkingBand({ aids }: WalkingBandProps) {
  const t = useTranslations("assistant.walk");
  const ta = useTranslations("aids");
  const [state, setState] = useState<AssistantStatusDetail | null>(null);

  useEffect(() => {
    const onStatus = (event: Event): void => {
      setState((event as CustomEvent<AssistantStatusDetail>).detail);
    };
    window.addEventListener(ASSISTANT_STATUS_EVENT, onStatus);
    return () => window.removeEventListener(ASSISTANT_STATUS_EVENT, onStatus);
  }, []);

  const walk = state?.walk ?? null;
  if (walk === null) return null;
  const aid = aids.find((candidate) => candidate.id === walk.aidId) ?? null;

  return (
    <div className="col walking">
      <div className="row walking-band">
        <StatusMark tone="run" caret={state?.answering === true}>
          {t("walking")}
        </StatusMark>
        <span className="small walking-line">{t("band", { n: walk.step, m: walk.of })}</span>
      </div>
      {aid === null ? null : (
        <div className="col aid-tree">
          <span className="cap">
            {t("pick")} · {ta(aidKey(aid, "title")).toLowerCase()}
          </span>
          <ol className="tree box aid-tree-list" aria-label={t("stepsLabel")}>
            <li className="aid-tree-root">
              <span className="glyph" aria-hidden="true">
                ✢
              </span>
              <span>{ta(aidKey(aid, "title"))}</span>
            </li>
            {aid.steps.map((step, index) => {
              const n = index + 1;
              const current = stepState(n, walk.step);
              return (
                <li key={step.ordinal} className={cn("aid-tree-step", `is-${current}`)} aria-current={current === "now" ? "step" : undefined}>
                  <span aria-hidden="true">{index === aid.steps.length - 1 ? "└─" : "├─"}</span>
                  <span>
                    {n} · {ta(aidKey(aid, "steps", step.titleKey))}
                  </span>
                  {current === "later" ? null : <span className="aid-tree-mark">{t(current)}</span>}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
