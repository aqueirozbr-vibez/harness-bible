"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";

import { StatusMark } from "@/components/ui/StatusMark";
import { onSubmitRefused, type SubmitRefused } from "@/lib/hooks/draftView";

interface SubmitProblemProps {
  /** The refusal codes this field shows, space-separated: `INTAKE_ANCHOR_EXISTS`, `CONSENT_REQUIRED`. */
  readonly codes: string;
  /** What the field offers to set it right, as the Components screen's `Choose an anchor`. */
  readonly action?: ReactNode;
}

/**
 * A submission's refusal shown beside the field it concerns (feature-specs/34 § 6), in the Components screen's error
 * form: what failed (`anchor not found`), who said so (`intake sensor`), the server's words and the sensor's own,
 * the trace, and what to do. It listens for Submit's refusals and shows the one its codes name; a new submission
 * clears it.
 */
export function SubmitProblem({ codes, action }: SubmitProblemProps) {
  const t = useTranslations("improve.suggest.submit");
  const tc = useTranslations("improve.suggest.create");
  const [refused, setRefused] = useState<SubmitRefused | null>(null);

  useEffect(() => onSubmitRefused((detail) => setRefused(detail !== null && codes.split(" ").includes(detail.code) ? detail : null)), [codes]);

  if (refused === null) return null;
  return (
    <div className="error col gap-s2 submit-problem" role="alert">
      <div className="between">
        <StatusMark tone="fail">{t(`sensor.${refused.code.replace(/^INTAKE_/, "")}`)}</StatusMark>
        <span className="meta faint">{t(refused.code === "CONSENT_REQUIRED" ? "consentSource" : "sensorSource")}</span>
      </div>
      <p className="small">{refused.message}</p>
      {refused.detail !== null ? <p className="tex submit-problem-detail">{refused.detail}</p> : null}
      {refused.traceId !== null ? <p className="meta faint">{tc("trace", { traceId: refused.traceId })}</p> : null}
      {action !== undefined ? <div className="row">{action}</div> : null}
    </div>
  );
}
