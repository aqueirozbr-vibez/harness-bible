"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { ProposalPanel } from "@/components/assistant/ProposalPanel";
import { SuggestGateNotice } from "@/components/improve/SuggestGateNotice";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useRunFollow } from "@/lib/hooks/useRunFollow";
import { formatDayMonth } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { findingActionOf, refusalOfAnswer, SEND_FOLLOW_MS, sendSettled, type FindingLine, type FindingLocal, type FindingRefusal, type FindingRole } from "@/lib/research/findingAction";
import { researchRefHref, type ResearchRefBase } from "@/lib/research/links";
import { ResearchFindingDraftedSchema, ResearchRunViewSchema, type ResearchFindingView, type ResearchRunView } from "@/lib/schemas/api";
import { RESEARCH_SENDS_PER_MONTH } from "@/lib/schemas/research";

/*
 * A finding's one button, by role, and what became of it (feature-specs/48 § 8.1, § 8.2, § 8.3, § 18, § 20; unit 74).
 * What it shows is `findingActionOf`'s (lib/research/findingAction.ts); this island presses and follows.
 *
 * `Draft it in Improve` (a verified contributor or curator), with its help line — the press starts one paid grading per
 * source — posts the draft with an `Idempotency-Key` kept across retries of the press, and on its 201 the page goes to
 * the draft's edit page. `Send to Improve` (anyone else) opens the shared `ConfirmDialog` first, since a submission is a
 * record and is not taken back; on the 202 the block reads `sending to Improve` and follows the run's view with the
 * run's own follow (`useRunFollow`) for at most a minute, until the finding is sent, a duplicate, or carries the code of
 * why not; then its line, and after the minute `reload to follow`. A 409 `FINDING_USED` is the finding read again from
 * the run's view and shown as it now is; every other refusal is its line (§ 18), and the engine that could not take it
 * now offers the button again.
 *
 * Focus (§ 20): the pressed button is replaced by the status line, which takes `tabIndex={-1}` and the focus — the
 * dialog's own return would go to the button that unmounted — or by its link where the line has one (`Open draft`). The
 * block is inside the run's findings container, which is `aria-live="off"`, so nothing here is read out but what takes
 * the focus. 44px targets under `pointer: coarse` (the `.finding-action .btn` rule).
 *
 * Since unit 76 the same block stands in a row of the Improve landing page's `From a research` (48 § 10.2, `place`
 * `improve`), which lists unused findings alone. There a throttled contributor's notice stands once above the table, not
 * in each row; and a settled send, or a finding read again, does not refresh the page, which would take the row away
 * with the line that says what became of the finding and the focus on it — only a finding gone from its run does, since
 * its row is gone too. The throttle notice is step 1's own (`SuggestGateNotice`, § 18).
 */

interface FindingActionProps {
  readonly finding: ResearchFindingView;
  readonly runId: string;
  readonly role: FindingRole;
  readonly locale: Locale;
  readonly refBase: ResearchRefBase;
  /** Where the block stands: under its finding in a run (the default), or in a row of the Improve landing page's `From a research` (48 § 10.2). */
  readonly place?: "run" | "improve";
}

export function FindingAction({ finding: given, runId, role, locale, refBase, place = "run" }: FindingActionProps) {
  const t = useTranslations("research.findings");
  const router = useRouter();
  const helpId = useId();
  /* the finding as this block last read it: the page's, then the follow's or a read-back's (React's own way to follow a prop) */
  const [finding, setFinding] = useState(given);
  const seen = `${given.use.state}:${given.use.failure ?? ""}:${given.use.suggestionId ?? ""}:${given.use.href ?? ""}`;
  const [synced, setSynced] = useState(seen);
  if (synced !== seen) {
    setSynced(seen);
    setFinding(given);
  }
  const [local, setLocal] = useState<FindingLocal>({ kind: "idle" });
  const [confirming, setConfirming] = useState(false);
  /* one key per action, kept across retries of the same press (code-standards § Next.js) */
  const keyRef = useRef<{ readonly action: "draft" | "send"; readonly key: string } | null>(null);
  const lineRef = useRef<HTMLParagraphElement>(null);
  const openRef = useRef<HTMLAnchorElement>(null);
  const focusNext = useRef(false);

  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    (openRef.current ?? lineRef.current)?.focus();
  });

  const findingIn = (view: ResearchRunView): ResearchFindingView | null => view.findings.find((candidate) => candidate.id === given.id) ?? null;

  const { lost } = useRunFollow(local.kind === "sending" ? runId : null, {
    onView: (view) => {
      const next = findingIn(view);
      if (next !== null) setFinding(next);
      if (sendSettled(view, given.id)) {
        setLocal({ kind: "idle" });
        if (place === "run" || next === null) router.refresh();
      }
    },
    until: (view) => sendSettled(view, given.id),
    forMs: SEND_FOLLOW_MS,
  });
  const shown: FindingLocal = local.kind === "sending" && lost ? { kind: "lost" } : local;

  const keyFor = (action: "draft" | "send"): string => {
    if (keyRef.current?.action !== action) keyRef.current = { action, key: crypto.randomUUID() };
    return keyRef.current.key;
  };

  /** The finding read again from its run's view: a 409 `FINDING_USED`, or a 404, says it moved since the page read it. */
  const readAgain = async (): Promise<void> => {
    const read = await fetch(`/api/v1/research/runs/${encodeURIComponent(runId)}`, { headers: { accept: "application/json" } }).catch(() => null);
    const parsed = read !== null && read.ok ? ResearchRunViewSchema.safeParse(await read.json().catch(() => null)) : null;
    const next = parsed?.success === true ? findingIn(parsed.data) : null;
    if (next !== null) setFinding(next);
    if (place === "run" || next === null) router.refresh();
  };

  /** A press not answered 2xx: its line, or the finding read again; the focus on what replaced the button. */
  const refused = async (response: Response | null): Promise<void> => {
    const body = response === null ? null : ((await response.json().catch(() => null)) as { code?: unknown; detail?: unknown } | null);
    const refusal: FindingRefusal | "reread" = response === null ? { kind: "unavailable" } : refusalOfAnswer(response.status, body);
    if (refusal === "reread") {
      await readAgain();
      setLocal({ kind: "idle" });
    } else setLocal({ kind: "refused", refusal });
    focusNext.current = true;
  };

  const draft = async (): Promise<void> => {
    setLocal({ kind: "pressed" });
    const response = await fetch(`/api/v1/research/findings/${encodeURIComponent(given.id)}/draft`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": keyFor("draft") },
      body: JSON.stringify({ locale }),
    }).catch(() => null);
    if (response !== null && response.status === 201) {
      const drafted = ResearchFindingDraftedSchema.safeParse(await response.json().catch(() => null));
      /* the draft is the contributor's now: its edit page, where the rail shows what came from the research */
      if (drafted.success) {
        router.push(drafted.data.href);
        return;
      }
      await readAgain();
      setLocal({ kind: "idle" });
      return;
    }
    await refused(response);
  };

  const send = async (): Promise<void> => {
    setLocal({ kind: "pressed" });
    const response = await fetch(`/api/v1/research/findings/${encodeURIComponent(given.id)}/propose`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": keyFor("send") },
      body: "{}",
    }).catch(() => null);
    setConfirming(false);
    if (response !== null && response.status === 202) {
      keyRef.current = null;
      /* the code an earlier send left was cleared before the start (§ 8.3 step 6) */
      setFinding((current) => ({ ...current, use: { ...current.use, failure: null } }));
      setLocal({ kind: "sending" });
      focusNext.current = true;
      return;
    }
    await refused(response);
  };

  const view = findingActionOf(finding, role, shown);
  const lineText = (line: FindingLine): string => {
    if (line.key === "sendsLimit") return t("sendsLimit", { max: RESEARCH_SENDS_PER_MONTH, date: formatDayMonth(new Date(line.values.resetsAt ?? ""), locale) });
    return t(line.key, line.values);
  };
  /* on the landing page a throttled contributor's notice stands once above the table (48 § 10.2); a press refused 429 still says it here */
  const throttled = view.throttled === null || (place === "improve" && role.kind === "throttled") ? null : new Date(view.throttled);

  return (
    <div className="col finding-action">
      {view.line === null ? null : (
        <p ref={lineRef} tabIndex={-1} className="meta finding-use">
          {lineText(view.line)}
          {view.open === null ? null : (
            <>
              {" · "}
              <Link ref={openRef} href={`/${locale}${view.open}`} className="xref">
                {t("openDraft")}
              </Link>
            </>
          )}
        </p>
      )}
      {throttled === null ? null : <SuggestGateNotice gate={{ kind: "throttled", until: throttled }} locale={locale} />}
      {view.button === null ? null : view.button.action === "draft" ? (
        <div className="col finding-press">
          <Button
            size="sm"
            disabled={view.button.disabled}
            aria-describedby={helpId}
            onClick={() => {
              void draft();
            }}
          >
            {t("draft")}
          </Button>
          <p id={helpId} className="help">
            {t("draftHelp")}
          </p>
        </div>
      ) : (
        <div className="col finding-press">
          <Button size="sm" disabled={view.button.disabled} onClick={() => setConfirming(true)}>
            {t("send")}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={t("sendTitle")}
        body={t("sendBody")}
        cancelLabel={t("sendCancel")}
        confirmLabel={t("sendConfirm")}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          void send();
        }}
        confirmDisabled={local.kind === "pressed"}
        cancelDisabled={local.kind === "pressed"}
      />
      {view.proposal && finding.proposal !== null ? <ProposalPanel proposal={finding.proposal} context="report" hrefOf={(sectionId) => researchRefHref(refBase, sectionId)} locale={locale} /> : null}
    </div>
  );
}
