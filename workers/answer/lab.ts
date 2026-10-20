import { getPrisma } from "@/lib/db/client";
import { withSystem } from "@/lib/db/tenant";
import { checkedFigures } from "@/lib/labs/checkedFigures";
import { lastRunText, pseudoId, readmeText, type LabFacts } from "@/lib/labs/pseudoSections";
import { parseFigureId, parseSectionId } from "@/lib/schemas/ids";
import type { PromptSection } from "@/workers/agents/assistant/assemble";

/*
 * Lab mode's extra reading (feature-specs/19 § 4), loaded in the workers: the release's `Lab` row and the chapter's
 * figures whose derive links name this lab, checked against CI's `derived` in code, then shaped as the two
 * pseudo-sections retrieval appends. Both cite as the chapter's lab section, `NN.4`.
 */

/** The chapter a lab belongs to in this release, or null when the release has no such lab (feature-specs/23 § 5.1). */
export async function labChapterOf(releaseId: string, labId: string): Promise<number | null> {
  const lab = await withSystem(async () =>
    getPrisma().lab.findFirst({ where: { anchor: labId, chapterVersion: { releaseId } }, select: { chapterVersion: { select: { chapterNumber: true } } } }),
  );
  return lab?.chapterVersion.chapterNumber ?? null;
}

export interface LoadedLab {
  readonly facts: LabFacts;
  readonly textEn: string;
  /** The chapter's lab section, which the pseudo-sections cite as. */
  readonly anchor: { readonly chapter: number; readonly version: string; readonly verify: PromptSection["section"]["verify"] };
}

export async function loadLab(releaseId: string, labId: string): Promise<LoadedLab | null> {
  return withSystem(async () => {
    const prisma = getPrisma();
    const lab = await prisma.lab.findFirst({
      where: { anchor: labId, chapterVersion: { releaseId } },
      select: {
        anchor: true,
        title: true,
        textEn: true,
        expectedRuntimeS: true,
        declaresModelCalls: true,
        egressExtra: true,
        ciVerdict: true,
        ciCheckedAt: true,
        derived: true,
        chapterVersion: { select: { chapterNumber: true, version: true, verifyStatus: true } },
      },
    });
    if (lab === null) return null;
    const figures = await prisma.figure.findMany({
      where: { derive: { is: { labId } }, section: { chapterVersion: { releaseId } } },
      orderBy: { anchor: "asc" },
      select: { anchor: true, label: true, valueText: true, tier: true, section: { select: { anchor: true } }, derive: { select: { key: true, line: true, filePath: true } } },
    });
    const facts: LabFacts = {
      labId: lab.anchor,
      number: lab.chapterVersion.chapterNumber,
      title: lab.title,
      expectedRuntimeS: lab.expectedRuntimeS,
      declaresModelCalls: lab.declaresModelCalls,
      egressExtra: lab.egressExtra,
      ciVerdict: lab.ciVerdict,
      ciCheckedAt: lab.ciCheckedAt?.toISOString() ?? null,
      figures: checkedFigures(
        figures.flatMap((figure) =>
          figure.derive === null
            ? []
            : [{ figureId: parseFigureId(figure.anchor), sectionId: parseSectionId(figure.section.anchor), label: figure.label, valueText: figure.valueText, tier: figure.tier, key: figure.derive.key, line: figure.derive.line, filePath: figure.derive.filePath }],
        ),
        lab.derived,
      ),
    };
    return { facts, textEn: lab.textEn, anchor: { chapter: lab.chapterVersion.chapterNumber, version: lab.chapterVersion.version, verify: lab.chapterVersion.verifyStatus } };
  });
}

/** The two pseudo-sections as prompt sections, after the retrieved ones (`from` is the next rank). */
export function labPromptSections(loaded: LoadedLab, from: number): ReadonlyArray<PromptSection> {
  const { facts } = loaded;
  const sectionId = parseSectionId(`${String(loaded.anchor.chapter).padStart(2, "0")}.4`);
  const base = {
    sectionId,
    chapter: loaded.anchor.chapter,
    layer: 4,
    version: loaded.anchor.version,
    verify: loaded.anchor.verify,
    editionLang: "EN" as const,
    truncated: false,
  };
  const rank = (final: number) => ({ lexicalPos: null, vectorPos: null, rerankScore: null, final });
  return [
    {
      section: { ...base, title: `Lab ${String(facts.number).padStart(2, "0")} · README`, text: readmeText(facts, loaded.textEn), figureIds: [], rank: rank(from), pseudo: { id: pseudoId(facts.labId, "readme"), labId: facts.labId, kind: "readme" } },
      figures: [],
    },
    {
      section: {
        ...base,
        title: `Lab ${String(facts.number).padStart(2, "0")} · last run`,
        text: lastRunText(facts),
        figureIds: facts.figures.map((figure) => figure.figureId),
        rank: rank(from + 1),
        pseudo: { id: pseudoId(facts.labId, "lastRun"), labId: facts.labId, kind: "lastRun" },
      },
      figures: facts.figures.map((figure) => ({ figureId: figure.figureId, label: figure.label, valueText: figure.chapterValue, tier: figure.tier, derive: { filePath: figure.filePath, line: figure.line } })),
    },
  ];
}
