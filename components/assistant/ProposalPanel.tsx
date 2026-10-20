"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { ChangeTable } from "@/components/improve/ChangeTable";
import { hasWhere, ProposalWhere } from "@/components/improve/ProposalWhere";
import { Cite } from "@/components/ui/Cite";
import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import type { Locale } from "@/lib/i18n/routing";
import type { ProposalView } from "@/lib/schemas/api";

/*
 * A research proposal under the answer it came from (feature-specs/43 § 5.1; unit 60b, part 2): an instrument of its
 * own, headed `proposal for the book · <id> · not part of the answer`, so it is never read as the answer. Its body is
 * the anchor (a link to its section), the class, the change before and after, what it rests on — each source's host,
 * tier and adjusted score, and the line Improve's score makes against the accept line, or a curator-always class with
 * its reason — the researcher's note with the sentence that the adjudicator did not read it, and where it stands. Its
 * footer is the reader's: `Add my name` opens the consent inline, the suggest form's sentence with one of the panel's
 * own, and the button stays disabled until the box is ticked; once the name is on, `Remove my name` until the merge.
 *
 * Keyboard: the consent opens with focus on its box; `Esc` inside it closes it alone and gives focus back to `Add my
 * name`, never reaching the dock's own `Esc`; a press that lands moves focus to the button that replaced the one pressed.
 * A failure is said in the footer and never in the answer block — the engine down or a 5xx `could not add your name ·
 * try again later` (or `remove`), a 429 the rate's line — inside the dock's log, which announces it, with no live
 * region of its own (D15). A 409 is a proposal past taking names: the control goes, the footer says so and takes the
 * focus to `View record`; a 404 to a removal is a name already gone, read as removed. The panel is keyed by its
 * proposal alone and takes a newer view of it as it comes, so a poll never takes the focus from it (review of unit 60).
 *
 * Since unit 74 it also stands under a finding a person sent from a research report that Improve proposed
 * (feature-specs/48 § 8.1, § 11.5): `context` says what it is not part of — `not part of the answer` under an answer,
 * `not part of the report` under a report — and `hrefOf` is where its anchor's link goes, the Assistant's `refHref` or
 * research's `researchRefHref`, so a research's link never opens the Assistant's dock.
 */

interface ProposalPanelProps {
  readonly proposal: ProposalView;
  /** What the panel stands under, and is not part of. */
  readonly context: "answer" | "report";
  /** A section's link, as the page it stands on makes one. */
  readonly hrefOf: (sectionId: string) => string;
  readonly locale: Locale;
}

/** The states in which a name is added or taken back (42 § 6). */
const ENDORSABLE = new Set<ProposalView["where"]["state"]>(["CURATOR_QUEUE", "MERGING"]);

type Failure = "failed" | "failedRemove" | "rate" | null;

export function ProposalPanel({ proposal, context, hrefOf, locale }: ProposalPanelProps) {
  const t = useTranslations("improve.proposal");
  const tc = useTranslations("rubric.thresholds.class");
  const tr = useTranslations("improve.suggest.class.reason");
  const ts = useTranslations("improve.suggest.submit");
  const tb = useTranslations("rubric");
  const headId = useId();
  const consentId = useId();
  const [endorsed, setEndorsed] = useState(proposal.endorsed);
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure>(null);
  /* a 409: the proposal is past taking names (merged, being merged, or closed meanwhile) */
  const [settled, setSettled] = useState(false);
  /* a newer view of the same proposal, from the dock's follow: taken as it comes, the panel kept (React's own way to follow a prop) */
  const seen = `${proposal.endorsed?.at ?? "none"}:${proposal.where.state}`;
  const [synced, setSynced] = useState(seen);
  if (synced !== seen) {
    setSynced(seen);
    setEndorsed(proposal.endorsed);
    setSettled(false);
  }
  const addRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLInputElement>(null);
  const recordRef = useRef<HTMLAnchorElement>(null);
  /* where focus goes once the control has changed: the button that replaced the one pressed, or the record once none is left */
  const focusNext = useRef<"add" | "remove" | "box" | "record" | null>(null);
  const moveFocus = (to: "add" | "remove" | "box" | "record"): void => {
    focusNext.current = to;
  };

  useEffect(() => {
    const next = focusNext.current;
    if (next === null) return;
    focusNext.current = null;
    (next === "add" ? addRef : next === "remove" ? removeRef : next === "box" ? boxRef : recordRef).current?.focus();
  });

  const { where, anchor } = proposal;
  const endorsable = ENDORSABLE.has(where.state) && !settled;

  const send = async (method: "POST" | "DELETE"): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(`/api/v1/proposals/${proposal.suggestionId}/endorse`, {
        method,
        headers: method === "POST" ? { "content-type": "application/json" } : {},
        ...(method === "POST" ? { body: JSON.stringify({ consent: true }) } : {}),
      });
      if (response.ok) {
        const body = (await response.json()) as { endorsed: ProposalView["endorsed"] };
        setEndorsed(body.endorsed);
        setOpen(false);
        setTicked(false);
        moveFocus(body.endorsed === null ? "add" : "remove");
        return;
      }
      if (response.status === 409) {
        setSettled(true);
        setOpen(false);
        moveFocus("record");
        return;
      }
      /* a removal of a name that is not there: taken back already, from another tab or another device */
      if (method === "DELETE" && response.status === 404) {
        setEndorsed(null);
        moveFocus("add");
        return;
      }
      setFailure(response.status === 429 ? "rate" : method === "DELETE" ? "failedRemove" : "failed");
    } catch {
      setFailure(method === "DELETE" ? "failedRemove" : "failed");
    } finally {
      setBusy(false);
    }
  };

  const closeConsent = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    /* the consent's own Esc: the dock's, which would close the dock, never sees it */
    event.stopPropagation();
    event.preventDefault();
    setOpen(false);
    setTicked(false);
    moveFocus("add");
  };

  const scoreLine =
    proposal.changeClass === "CURATOR_ALWAYS"
      ? t("curatorAlways", { reason: proposal.curatorReason === null ? "—" : tr(proposal.curatorReason) })
      : proposal.score === null
        ? null
        : proposal.acceptAt === null
          ? t("scoreOnly", { score: proposal.score })
          : t("score", { score: proposal.score, acceptAt: proposal.acceptAt });

  return (
    <section className="inst proposal-panel" aria-labelledby={headId} data-proposal={proposal.suggestionId}>
      <div className="inst-h">
        <h3 id={headId} className="t">
          {t("header")}
        </h3>
        <span className="sep" aria-hidden="true">
          ·
        </span>
        <span>{proposal.suggestionId}</span>
        <span className="sep" aria-hidden="true">
          ·
        </span>
        <span className="cap proposal-not-answer">{t(context === "answer" ? "notAnswer" : "notReport")}</span>
      </div>

      <div className="inst-b col proposal-body">
        <div className="row proposal-anchor">
          {anchor === null ? null : anchor.section === null ? (
            <span className="meta">{anchor.id}</span>
          ) : (
            <Cite href={hrefOf(anchor.section)} figureId={anchor.kind === "FIGURE" ? anchor.id : null}>
              {anchor.id}
              {/* the section's title is the book's, in its edition's language (ui-context § 12) */}
              {anchor.title === null ? null : <span lang={proposal.contentLang}> · {anchor.title}</span>}
            </Cite>
          )}
          <span className="small muted">{tc(proposal.changeClass)}</span>
        </div>

        <ChangeTable before={proposal.change.before} after={proposal.change.after} contentLang={proposal.contentLang} />

        <div className="col proposal-rests">
          <span className="cap">{t("sources")}</span>
          {proposal.sources.length === 0 ? null : (
            <ul className="proposal-sources">
              {proposal.sources.map((source, index) => (
                <li key={`${source.host ?? "source"}-${String(index)}`} className="row proposal-source">
                  <span className="small grow proposal-host">{source.host ?? "—"}</span>
                  {source.tier === null ? null : <EvidenceBadge tier={source.tier} label={tb("tiers.badge", { tier: source.tier, name: tb(`tiers.name.${source.tier}`) })} />}
                  <span className="score">{source.adjusted === null ? "—" : String(source.adjusted)}</span>
                </li>
              ))}
            </ul>
          )}
          {scoreLine === null ? null : <span className="meta proposal-score">{scoreLine}</span>}
        </div>

        {proposal.note === null ? null : (
          <div className="col proposal-note">
            <span className="cap">{t("note")}</span>
            <p className="small" lang={proposal.contentLang}>
              {proposal.note}
            </p>
            <p className="help">{t("noteUnread")}</p>
          </div>
        )}

        {hasWhere(where.state) ? (
          <span className="meta proposal-where">
            <ProposalWhere where={where} endorsed={endorsed} locale={locale} />
          </span>
        ) : null}
      </div>

      <div className="inst-f proposal-record">
        {/* the record, the asker's to read (43 § 8; unit 60e) */}
        <a ref={recordRef} href={`/${locale}/improve/${proposal.suggestionId}/record`}>
          {t("record")}
        </a>
      </div>
      {endorsable || failure !== null || settled ? (
        <div className="inst-f col proposal-actions">
          {endorsable && endorsed === null && !open ? (
            <button
              ref={addRef}
              type="button"
              className="btn btn-sm"
              aria-expanded={false}
              aria-controls={consentId}
              disabled={busy}
              onClick={() => {
                moveFocus("box");
                setOpen(true);
              }}
            >
              {t("endorse")}
            </button>
          ) : null}
          {endorsable && endorsed === null && open ? (
            <div id={consentId} className="col proposal-consent" onKeyDown={closeConsent}>
              <label className="check">
                <input ref={boxRef} type="checkbox" checked={ticked} onChange={(event) => setTicked(event.target.checked)} />
                {ts("consent")}
              </label>
              <p className="small">{t("consentMore")}</p>
              <div className="row proposal-confirm">
                <button
                  ref={addRef}
                  type="button"
                  className="btn btn-sm"
                  aria-describedby={ticked ? undefined : `${consentId}-help`}
                  disabled={!ticked || busy}
                  onClick={() => {
                    void send("POST");
                  }}
                >
                  {t("endorse")}
                </button>
                {ticked ? null : (
                  <span id={`${consentId}-help`} className="help">
                    {t("consentHelp")}
                  </span>
                )}
              </div>
            </div>
          ) : null}
          {endorsable && endorsed !== null ? (
            <button
              ref={removeRef}
              type="button"
              className="btn btn-sm btn-q"
              disabled={busy}
              onClick={() => {
                void send("DELETE");
              }}
            >
              {t("unendorse")}
            </button>
          ) : null}
          {/* inside the dock's log, which announces what is added to it: no region of its own (D15) */}
          {failure === null ? null : <p className="small proposal-failure">{t(failure)}</p>}
          {settled ? <p className="small proposal-settled">{endorsed === null ? t("settled") : t("settledWithName")}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
