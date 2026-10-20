"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { runSeconds } from "@/lib/assistant/walk";
import { formatSeconds } from "@/lib/i18n/format";
import { ASSISTANT_STATUS_EVENT, type AssistantStatusDetail } from "@/lib/hooks/citedPassages";

/*
 * The status bar's assistant cells (feature-specs/16 § 8): `assistant docked · explain`, with `· answering` while a
 * turn runs, and the trailing `first token 1.3 s` of the last answer. The dock owns those facts and lives in another
 * tree, so it sends them; the cells render from the URL's own state until the first event arrives.
 *
 * While a walk turn is current (feature-specs/18 § 5.3) the first cell reads `assistant docked · walk · step 2 of 4`
 * and the trailing one `derive run 0.8 s`, the script's time in place of the model's.
 */

interface AssistantStatusCellsProps {
  /** The dock is open on this page (`?ask=…`), so the cell renders before hydration too. */
  readonly open: boolean;
}

export function AssistantStatusCells({ open }: AssistantStatusCellsProps) {
  const t = useTranslations("assistant.dock");
  const tw = useTranslations("assistant.walk");
  const tm = useTranslations("assistant.mode");
  const [state, setState] = useState<AssistantStatusDetail | null>(null);

  useEffect(() => {
    const onStatus = (event: Event): void => {
      setState((event as CustomEvent<AssistantStatusDetail>).detail);
    };
    window.addEventListener(ASSISTANT_STATUS_EVENT, onStatus);
    return () => window.removeEventListener(ASSISTANT_STATUS_EVENT, onStatus);
  }, []);

  if (!open) return null;
  const mode = state?.mode ?? "explain";
  const walk = state?.walk ?? null;

  return (
    <>
      <span>
        {walk === null ? t("statusDocked", { mode: tm(`short.${mode}`) }) : tw("statusWalk", { n: walk.step, m: walk.of })}
        {state?.answering === true ? ` · ${t("answering")}` : ""}
      </span>
      {walk !== null && walk.runMs !== null ? (
        <span>{tw("runMs", { s: runSeconds(walk.runMs) })}</span>
      ) : (
        <span>{state?.firstTokenMs === null || state?.firstTokenMs === undefined ? t("firstTokenNone") : t("firstToken", { s: formatSeconds(state.firstTokenMs) })}</span>
      )}
    </>
  );
}
