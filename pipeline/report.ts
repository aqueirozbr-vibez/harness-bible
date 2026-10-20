/*
 * The ingestion report (feature-specs/04 § 6.11): what reviewers read.
 */

export interface ChapterReport {
  readonly chapter: number;
  readonly title: string;
  readonly stub: boolean;
  readonly words: number;
  readonly sections: number;
  readonly figuresByTier: Record<string, number>;
  readonly derivedLinked: number;
  readonly derivedTotal: number;
  readonly unlinked: ReadonlyArray<{ section: string; label: string; valueText: string; candidates: ReadonlyArray<string> }>;
  readonly untieredNumbers: number;
  readonly sourceRows: number;
  /** Rows of the four cited tiers, and how many of them carry a URL or DOI (feature-specs/10 § 5.2). */
  readonly sourceRowsCitable: number;
  readonly sourceRowsLinked: number;
  readonly unmatchedSources: ReadonlyArray<string>;
  readonly crossReferences: number;
  readonly codeBlocks: number;
  readonly labBlocks: number;
  readonly mermaidFigures: number;
  readonly mermaidFailed: number;
  readonly lab: { id: string; verdict: string | null; checkedAt: string | null } | null;
  readonly verify: string;
  readonly redteam: string;
  readonly redteamOpen: number;
  readonly version: string;
  readonly contentHash: string;
  readonly warnings: ReadonlyArray<string>;
}

export interface IngestReport {
  readonly release: string;
  readonly gitSha: string;
  readonly renderHash: string;
  readonly expectedHash: string | null;
  readonly hashMatches: boolean | null;
  readonly dryRun: boolean;
  readonly skipped: ReadonlyArray<{ chapter: number; reason: string }>;
  readonly chapters: ReadonlyArray<ChapterReport>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export function formatReport(report: IngestReport): string {
  const lines: string[] = [];
  lines.push(`release ${report.release} · gitSha ${report.gitSha} · renderHash ${report.renderHash}${report.hashMatches === null ? "" : report.hashMatches ? " · matches expected" : " · DIFFERS from expected"}${report.dryRun ? " · dry run" : ""}`);
  lines.push(`ch  words  sect  fig  der linked  cited  rows  links   xref  code  mermaid  lab            verify  redteam  version`);
  for (const c of report.chapters) {
    const figs = Object.values(c.figuresByTier).reduce((a, b) => a + b, 0);
    const cited = (c.figuresByTier.PRIMARY ?? 0) + (c.figuresByTier.VENDOR ?? 0) + (c.figuresByTier.ANALYST ?? 0) + (c.figuresByTier.PRACTITIONER ?? 0);
    const lab = c.lab === null ? "—" : `${c.lab.verdict ?? "?"}`;
    lines.push(
      `${String(c.chapter).padStart(2, "0")}  ${String(c.words).padStart(5)}  ${String(c.sections).padStart(4)}  ${String(figs).padStart(3)}  ${String(c.derivedLinked).padStart(3)}/${String(c.derivedTotal).padEnd(3)}   ${String(cited).padStart(5)}  ${String(c.sourceRows).padStart(4)}  ${String(c.sourceRowsLinked).padStart(3)}/${String(c.sourceRowsCitable).padEnd(3)} ${String(c.crossReferences).padStart(4)}  ${String(c.codeBlocks).padStart(4)}  ${String(c.mermaidFigures).padStart(2)}${c.mermaidFailed > 0 ? `(-${c.mermaidFailed})` : "   "}   ${lab.padEnd(14)} ${c.verify.padEnd(10)} ${c.redteam.padEnd(10)} ${c.version}${c.stub ? "  STUB" : ""}`,
    );
  }
  const linked = report.chapters.reduce((a, c) => a + c.sourceRowsLinked, 0);
  const citable = report.chapters.reduce((a, c) => a + c.sourceRowsCitable, 0);
  lines.push(`sources linked ${linked}/${citable}`);
  for (const s of report.skipped) lines.push(`skipped ch${String(s.chapter).padStart(2, "0")}: ${s.reason}`);
  const unlinked = report.chapters.flatMap((c) => c.unlinked.map((u) => `ch${String(c.chapter).padStart(2, "0")} ${u.section} "${u.label}" ${u.valueText}${u.candidates.length > 0 ? ` (candidates: ${u.candidates.join(", ")})` : ""}`));
  if (unlinked.length > 0) lines.push(`unlinked derived figures (${unlinked.length}):`, ...unlinked.slice(0, 40).map((l) => `  ${l}`), ...(unlinked.length > 40 ? [`  … ${unlinked.length - 40} more in the JSON report`] : []));
  const warnings = report.chapters.flatMap((c) => c.warnings.map((w) => `ch${String(c.chapter).padStart(2, "0")}: ${w}`));
  if (warnings.length > 0) lines.push(`warnings (${warnings.length}):`, ...warnings.slice(0, 40).map((w) => `  ${w}`));
  lines.push(`${report.chapters.length} chapters · ${report.durationMs} ms`);
  return lines.join("\n");
}
