"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";

import { Empty } from "@/components/ui/Empty";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { Mode } from "@/lib/schemas/assistant";

/*
 * The context line per mode, and the pickers a mode needs (feature-specs/24 § 5.3, after 19 § 3). Since Assistant
 * 2.0 the dock stands beside no chapter, so nothing here names "this chapter": explain says how much of the book the
 * assistant can read; compare picks both chapters, with `swap` exchanging them; lab picks any lab of the release and
 * names its last run; walk names the aid the form below has picked; brief names Part III. A pick is made here, in
 * sight, and lasts until it is changed — there is no page to go to in order to "change context".
 */

export interface DockChapterOption {
  readonly number: number;
  readonly title: string;
  readonly version: string;
  readonly verified: boolean;
}

export interface DockLab {
  readonly id: string;
  /** The lab's chapter, whose number the lab carries, and that chapter's version and verification. */
  readonly chapter: number;
  readonly version: string;
  readonly verified: boolean;
  readonly title: string;
  /** CI's verdict and date (spec 19 D2); null when CI never ran. */
  readonly verdict: string | null;
  readonly checkedAt: string | null;
}

interface ModeContextProps {
  readonly mode: Mode;
  readonly locale: Locale;
  /** How many of the release's chapters passed VERIFY, and how many it has: what explain can read. */
  readonly verified: number;
  readonly total: number;
  /** The release's chapters, for compare's two selects: unverified ones are listed but disabled. */
  readonly chapters: ReadonlyArray<DockChapterOption>;
  readonly first: number | null;
  readonly second: number | null;
  readonly onFirst: (chapter: number | null) => void;
  readonly onSecond: (chapter: number | null) => void;
  readonly onSwap: () => void;
  /** The release's labs, and the one lab mode has picked. */
  readonly labs: ReadonlyArray<DockLab>;
  readonly lab: DockLab | null;
  readonly onLab: (id: string | null) => void;
  /** Walk mode: the section of the aid the form has picked; null when the release has no aid. */
  readonly walkSection: string | null;
  readonly disabled: boolean;
}

function pad(chapter: number): string {
  return String(chapter).padStart(2, "0");
}

/** The pair as the post carries it: both picked and different, in the order the reader left them (feature-specs/19 § 3). */
export function comparePair(first: number | null, second: number | null): readonly [number, number] | null {
  if (first === null || second === null || first === second) return null;
  return [first, second];
}

export function ModeContext({ mode, locale, verified, total, chapters, first, second, onFirst, onSecond, onSwap, labs, lab, onLab, walkSection, disabled }: ModeContextProps) {
  const t = useTranslations("assistant.dock");
  const tc = useTranslations("assistant.compare");
  const tl = useTranslations("assistant.lab");
  const tb = useTranslations("assistant.brief");
  const tw = useTranslations("assistant.walk");
  const firstId = useId();
  const secondId = useId();
  const labId = useId();
  const book = t("contextBook", { verified, total });

  if (mode === "compare") {
    const pair = comparePair(first, second);
    const versionOf = (n: number): string => chapters.find((candidate) => candidate.number === n)?.version ?? "";
    const select = (id: string, value: number | null, other: number | null, onChange: (chapter: number | null) => void) => (
      <select id={id} className="select mono" value={value === null ? "" : String(value)} disabled={disabled} onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}>
        <option value="">{tc("choose")}</option>
        {chapters.map((candidate) => (
          <option key={candidate.number} value={String(candidate.number)} disabled={candidate.number === other || !candidate.verified}>
            {`ch${pad(candidate.number)} · ${candidate.title.toLowerCase()}${candidate.verified ? "" : ` · ${tc("unverified")}`}`}
          </option>
        ))}
      </select>
    );
    return (
      <div className="col dock-context gap-s2">
        <div className="row dock-context-pick">
          <label className="flabel" htmlFor={firstId}>
            {tc("first")}
          </label>
          {select(firstId, first, second, onFirst)}
        </div>
        <div className="row dock-context-pick">
          <label className="flabel" htmlFor={secondId}>
            {tc("with")}
          </label>
          {select(secondId, second, first, onSecond)}
          {pair === null ? null : (
            <button type="button" className="xref" onClick={onSwap} disabled={disabled}>
              {tc("swap")}
            </button>
          )}
        </div>
        <span className="meta">{pair === null ? book : tc("context", { a: pad(pair[0]), va: versionOf(pair[0]), b: pad(pair[1]), vb: versionOf(pair[1]) })}</span>
      </div>
    );
  }

  if (mode === "lab") {
    if (labs.length === 0) {
      return (
        <div className="col dock-context gap-s2">
          <Empty caption={t("modeCap")}>{tl("noLabs")}</Empty>
        </div>
      );
    }
    return (
      <div className="col dock-context gap-s2">
        <div className="row dock-context-pick">
          <label className="flabel" htmlFor={labId}>
            {tl("kvLab")}
          </label>
          <select id={labId} className="select mono" value={lab?.id ?? ""} disabled={disabled} onChange={(event) => onLab(event.target.value === "" ? null : event.target.value)}>
            <option value="">{tl("choose")}</option>
            {labs.map((candidate) => (
              <option key={candidate.id} value={candidate.id} disabled={!candidate.verified}>
                {`Lab ${pad(candidate.chapter)} · ${candidate.title.toLowerCase()}${candidate.verified ? "" : ` · ${tc("unverified")}`}`}
              </option>
            ))}
          </select>
        </div>
        <span className="meta">
          {lab === null
            ? book
            : lab.verdict === null
              ? tl("contextNoRun", { n: pad(lab.chapter), v: lab.version })
              : tl("context", { n: pad(lab.chapter), v: lab.version, verdict: lab.verdict, date: lab.checkedAt === null ? "" : formatDate(new Date(lab.checkedAt), locale) })}
        </span>
      </div>
    );
  }

  if (mode === "brief") {
    return (
      <div className="dock-context">
        <span className="meta">{tb("contextOutside")}</span>
      </div>
    );
  }

  if (mode === "walk") {
    return (
      <div className="dock-context">
        <span className="meta">{walkSection === null ? book : tw("title", { section: walkSection })}</span>
      </div>
    );
  }

  return (
    <div className="dock-context">
      <span className="meta">{book}</span>
    </div>
  );
}
