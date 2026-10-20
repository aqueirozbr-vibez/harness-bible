import { useTranslations } from "next-intl";
import Link from "next/link";

import { StatusBar } from "@/components/chrome/StatusBar";
import { ProposalName } from "@/components/improve/ProposalName";
import { ProposalWhere } from "@/components/improve/ProposalWhere";
import { SuggestGateNotice } from "@/components/improve/SuggestGateNotice";
import { FindingAction } from "@/components/research/FindingAction";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { StatusMark } from "@/components/ui/StatusMark";
import { citedChaptersLabel } from "@/lib/assistant/label";
import { signInHref } from "@/lib/auth/signIn";
import type { ImproveHomeData } from "@/lib/db/improveHome";
import { formatDayMonth, formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { suggestChooserHref } from "@/lib/improve/suggest";
import { researchPageHref } from "@/lib/research/links";

interface ImproveHomeProps {
  readonly locale: Locale;
  readonly data: ImproveHomeData;
  readonly loadedMs: number;
  /** A draft just deleted, for the `Done` notice (feature-specs/45 § 4); undefined otherwise. */
  readonly deleted?: string;
}

/**
 * The Improve landing page (feature-specs/35 § 3; unit 52a; no screen draws it): what Improve is in three lines and
 * the link to the rubric; for a signed-out visitor the sign-in notice; for a contributor **Your suggestions**, their
 * own, drafts first, with the rows that wait on them marked; for a curator the queue's open count for their parts and
 * its link. Nothing of anyone else's, and no count by person (invariant 26). For any signed-in reader who has one, the
 * research proposals from their own questions (feature-specs/43 § 6; unit 60c), right under the heading: the id, the
 * anchor, where it stands, and their name where they put it — never the question. A reader with none sees no section.
 *
 * Improve's two starts (feature-specs/48 § 10.2, A11, story 4; unit 76): `New suggestion` in the head for every visitor,
 * to the chooser, which tells anyone who does not draft why and sends a signed-out visitor to sign in; and, for a
 * signed-in person with findings not yet used, **From a research** right under the heading, with its anchor link in the
 * head: each finding's research (its label and the run's day, a link to the run on the Research page), its anchor and
 * its section's title, its kind of change, and its button by role or its line (`FindingAction`, in its `improve`
 * place), with the send's follow after a 202. A throttled contributor reads the throttle notice once above the table and
 * no button. Never the question or the report; and each finding comes without its note, its change and its sources
 * (`unusedFindingsOf`), which the row does not show and `FindingAction`, whose props reach the page whole, does not read.
 */
export function ImproveHome({ locale, data, loadedMs, deleted }: ImproveHomeProps) {
  const t = useTranslations("improve.home");
  const tc = useTranslations("rubric.thresholds.class");
  const th = useTranslations("home.statusbar");
  return (
    <>
      <main className="improve-home">
        <div className="col improve-home-head">
          <span className="cap">{t("cap")}</span>
          <h1 className="h1">{t("title")}</h1>
          <p className="muted improve-home-lines">{t("what")}</p>
          <div className="row improve-home-starts">
            <Button variant="primary" href={suggestChooserHref(locale)}>
              {t("new")}
            </Button>
            <Link className="xref" href={`/${locale}/rubric`}>
              {t("rubric")}
            </Link>
            {data.fromResearch !== null ? (
              <Link className="xref" href="#from-research">
                {t("fromResearch.title")}
              </Link>
            ) : null}
          </div>
        </div>
        {deleted !== undefined ? <Notice title={t("notice.title")}>{t("notice.deleted", { id: deleted })}</Notice> : null}
        {!data.signedIn ? (
          <Notice title={t("signIn.title")}>
            {t("signIn.body")}{" "}
            <Link className="xref" href={signInHref(locale, `/${locale}/improve`)}>
              {t("signIn.link")}
            </Link>
          </Notice>
        ) : null}
        {data.fromResearch !== null ? <FromResearch locale={locale} fromResearch={data.fromResearch} /> : null}
        {data.proposals.length > 0 ? (
          <section className="col improve-home-proposals" aria-labelledby="improve-proposals-title">
            <h2 className="h4" id="improve-proposals-title">
              {t("proposals.title")}
            </h2>
            <table className="tbl improve-home-table">
              <thead>
                <tr>
                  <th scope="col">{t("proposals.id")}</th>
                  <th scope="col">{t("proposals.anchor")}</th>
                  <th scope="col">{t("proposals.where")}</th>
                  <th scope="col">{t("proposals.name")}</th>
                </tr>
              </thead>
              <tbody>
                {data.proposals.map((proposal) => (
                  <tr key={proposal.suggestionId} data-proposal-row={proposal.suggestionId}>
                    <td className="m">
                      <Link className="xref" href={`/${locale}/improve/${proposal.suggestionId}/record`}>
                        {proposal.suggestionId}
                      </Link>
                    </td>
                    <td>
                      {proposal.anchor === null ? (
                        "—"
                      ) : (
                        <>
                          <span className="m">{proposal.anchor.id}</span>
                          {proposal.anchor.title === null ? null : <span lang={proposal.contentLang}> · {proposal.anchor.title}</span>}
                        </>
                      )}
                    </td>
                    <td>
                      <ProposalWhere where={proposal.where} endorsed={null} locale={locale} />
                    </td>
                    <td>{proposal.endorsed === null ? "—" : <ProposalName suggestionId={proposal.suggestionId} removable={proposal.where.state === "CURATOR_QUEUE" || proposal.where.state === "MERGING"} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        {data.queue !== null ? (
          <section className="col improve-home-queue" aria-labelledby="improve-queue-title">
            <h2 className="h4" id="improve-queue-title">
              {t("queue.title")}
            </h2>
            <p className="small">{t("queue.count", { n: data.queue })}</p>
            <Link className="xref" href={`/${locale}/improve/queue`}>
              {t("queue.link")}
            </Link>
            <Link className="xref" href={`/${locale}/improve/research`}>
              {t("queue.researchLog")}
            </Link>
          </section>
        ) : null}
        {data.own !== null ? (
          <section className="col improve-home-own" aria-labelledby="improve-own-title">
            <h2 className="h4" id="improve-own-title">
              {t("own.title")}
            </h2>
            {data.own.length === 0 ? (
              <div className="empty improve-home-empty">
                <span className="h4">{t("own.empty")}</span>
              </div>
            ) : (
              <table className="tbl improve-home-table">
                <thead>
                  <tr>
                    <th scope="col">{t("own.id")}</th>
                    <th scope="col">{t("own.anchor")}</th>
                    <th scope="col">{t("own.class")}</th>
                    <th scope="col">{t("own.state")}</th>
                    <th scope="col" className="n">
                      {t("own.score")}
                    </th>
                    <th scope="col" className="n">
                      {t("own.age")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.own.map((row) => (
                    <tr key={row.id}>
                      <td className="m">
                        <Link className="xref" href={row.href}>
                          {row.id}
                        </Link>
                      </td>
                      <td className="m">{row.anchor}</td>
                      <td>{tc(row.changeClass)}</td>
                      <td>
                        <span className="improve-home-state">{row.withdrawn ? t(row.state === "CLOSED" ? "withdrawn" : "withdrawing") : row.outcome !== null && (row.state === "DECIDED" || row.state === "CURATOR_QUEUE") ? t(`outcome.${row.outcome}`) : t(`state.${row.state}`)}</span>
                        {row.waitsOnYou ? (
                          <>
                            {" "}
                            <StatusMark tone="warn">{t("own.waits")}</StatusMark>
                          </>
                        ) : null}
                      </td>
                      <td className="n">{row.score === null ? "—" : row.acceptAt === null ? String(row.score) : t("own.against", { score: row.score, accept: row.acceptAt })}</td>
                      <td className="n">{t("own.since", { n: row.days })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="help">{t("own.start")}</p>
          </section>
        ) : null}
      </main>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{t("statusbar", { release: data.release.id })}</span>
      </StatusBar>
    </>
  );
}

/**
 * `From a research` (48 § 10.2): the person's findings not yet used, newest first and at most fifty
 * (`UNUSED_FINDINGS_MAX`), each row the finding's research, its anchor, its kind of change and its block — the button of
 * the person's role or what became of it, followed after a send as under its run. The section is the head's
 * `#from-research` target.
 */
function FromResearch({ locale, fromResearch }: { readonly locale: Locale; readonly fromResearch: NonNullable<ImproveHomeData["fromResearch"]> }) {
  const t = useTranslations("improve.home.fromResearch");
  const tl = useTranslations("research.list");
  const tk = useTranslations("improve.suggest.edit.kindCap");
  const { role, findings } = fromResearch;
  return (
    <section className="col improve-home-research" id="from-research" aria-labelledby="improve-research-title">
      <h2 className="h4" id="improve-research-title">
        {t("title")}
      </h2>
      {role.kind === "throttled" ? <SuggestGateNotice gate={{ kind: "throttled", until: new Date(role.until) }} locale={locale} /> : null}
      <table className="tbl improve-home-table">
        <thead>
          <tr>
            <th scope="col">{t("research")}</th>
            <th scope="col">{t("anchor")}</th>
            <th scope="col">{t("kind")}</th>
            <th scope="col">{t("action")}</th>
          </tr>
        </thead>
        <tbody>
          {findings.map(({ research, run, contentLang, finding }) => (
            <tr key={finding.id} data-finding-row={finding.id}>
              <td>
                <Link className="xref" href={`${researchPageHref(locale, { research: research.id })}#run-${run.id}`}>
                  {citedChaptersLabel(research.chapters) ?? tl("noSections")}
                </Link>{" "}
                <span className="meta">· {formatDayMonth(run.createdAt, locale)}</span>
              </td>
              <td>
                {finding.anchor === null ? (
                  "—"
                ) : (
                  <>
                    <span className="meta">{finding.anchor.id}</span>
                    {finding.anchor.title === null ? null : <span lang={contentLang}> · {finding.anchor.title}</span>}
                  </>
                )}
              </td>
              <td>{finding.changeKind === null ? "—" : tk(finding.changeKind)}</td>
              <td>
                <FindingAction finding={finding} runId={run.id} role={role} locale={locale} refBase={{ locale, research: null }} place="improve" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="help">{t("kept")}</p>
    </section>
  );
}
