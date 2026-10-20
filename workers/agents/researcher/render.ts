import type { ResearchSection } from "@/lib/db/research";
import type { SourceTier } from "@/lib/db/generated/enums";
import type { Rubric } from "@/lib/schemas/rubric";

/*
 * What the researcher's two prompts share (feature-specs/41 § 5.1, § 6.1; unit 58c): a section rendered with its
 * figures and source rows in the fence the stub gateway reads too (`<section id=…>` … `figures:` lines), and text a
 * stranger wrote fenced as data, its closing tag broken so it cannot close the fence it is in. Dates are days
 * (`2026-03-04`), never instants: a time of day says nothing about a source and would move the bytes of a prompt
 * between two runs on the same section. A figure's or a row's tier is shown as the rubric's letter (`B` … `G`), which
 * is the scale the reader's guide explains, read from the published rubric's chip map; a chip the rubric maps to no
 * tier (an illustrative figure) is shown as what it is.
 */

export type TierOf = (chip: SourceTier) => string;

/** The rubric's chip map as a renderer; without a published rubric the chip's own name, lower-cased, stands. */
export function tierOfChips(rubric: Pick<Rubric, "chips"> | null): TierOf {
  return (chip) => {
    const tier = rubric?.chips[chip];
    if (tier === undefined) return chip.toLowerCase();
    return tier === null ? chip.toLowerCase() : tier;
  };
}

export function fenced(tag: string, text: string, attributes = ""): string {
  return `<${tag}${attributes}>\n${text.trim().replace(/<\//g, "<\\/")}\n</${tag}>`;
}

export function dayOf(date: Date | null): string {
  return date === null ? "none" : date.toISOString().slice(0, 10);
}

/** A section as both calls are shown it: the fence the assistant's sections use, then its figures and the rows they cite. */
export function renderSection(section: ResearchSection, tierOf: TierOf): string {
  const figures = section.figures.map((figure) => `${figure.id} "${figure.label.replace(/"/g, "'")}" ${figure.valueText}${figure.unit === null ? "" : ` ${figure.unit}`} (tier ${tierOf(figure.tier)}, verified ${dayOf(figure.verifiedOn)}${figure.fastMoving ? ", fast-moving" : ""}${figure.sourceRow === null ? "" : `, row ${figure.sourceRow}`})`);
  const rows = section.rows.map((row) => `${row.id} · tier ${tierOf(row.tier)} · verified ${dayOf(row.verifiedOn)}${row.fastMoving ? " · fast-moving" : ""} · ${row.claim} — ${row.citation}${row.url === null ? "" : ` · ${row.url}`}`);
  /* one `figures:` line, the items joined by `; `, as the assistant's assembler writes them (13 § 5) and the stub reads them */
  const body = [section.text.trim(), `figures: ${figures.length === 0 ? "none" : figures.join("; ")}`, rows.length === 0 ? "" : `source rows:\n${rows.join("\n")}`].filter((part) => part.length > 0).join("\n");
  return `<section id="${section.id}" chapter="${String(section.chapter)}" version="${section.version}" title="${section.title.replace(/"/g, "'")}" verified="${dayOf(section.verifiedOn)}">\n${body.replace(/<\//g, "<\\/")}\n</section>`;
}
