"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";

import { runPageId } from "@/lib/research/links";
import type { ResearchRunView } from "@/lib/schemas/api";

/*
 * The pages a run read (feature-specs/48 § 11.3, A7; unit 72): every page the research saw, numbered as its report
 * cites them, each row a link out in a new tab that says where it goes — the host, the page's title or its address
 * where it has none, `opened` or the search it was listed by — and that it opens a new tab. The link sends no referrer
 * and no endorsement (`noopener noreferrer nofollow`, `referrerpolicy="no-referrer"`), and only a web address is ever
 * a link. The row's id names its run as well as its number (`run-<runId>-page-<n>`): every run of a research is one
 * log and numbers its pages from 1. The container is there, empty and `aria-live="off"`, from the run block's first
 * render, so twenty-three rows are not read out when they arrive (§ 20).
 */

interface RunPagesProps {
  readonly run: ResearchRunView;
}

const WEB = /^https?:\/\//i;

export function RunPages({ run }: RunPagesProps) {
  const t = useTranslations("research.pages");
  const headId = useId();
  const pages = run.pages;
  return (
    <div className="run-pages-slot" aria-live="off">
      {pages.length === 0 ? null : (
        <section className="inst run-pages" aria-labelledby={headId}>
          <div className="inst-h">
            <h3 id={headId} className="t">
              {t("cap", { n: pages.length, opened: pages.filter((page) => page.opened).length })}
            </h3>
          </div>
          <ol className="run-pages-list">
            {pages.map((page) => {
              const words = (
                <>
                  <span className="run-page-host">{page.host}</span>
                  <span className="run-page-title">{page.title ?? page.url}</span>
                  {page.opened ? <span className="cap">{t("opened")}</span> : page.search === null ? null : <span className="cap">{t("inSearch", { n: page.search })}</span>}
                </>
              );
              return (
                <li key={page.n} id={runPageId(run.id, page.n)} className="run-page" tabIndex={-1}>
                  <span className="meta run-page-n">{page.n}</span>
                  {WEB.test(page.url) ? (
                    <a className="run-page-link" href={page.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
                      {words}
                      <span className="sr-only">{t("newTab")}</span>
                    </a>
                  ) : (
                    <span className="run-page-link">{words}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
