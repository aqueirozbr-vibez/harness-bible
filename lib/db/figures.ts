import { getPrisma } from "@/lib/db/client";
import { cached, currentRelease, requireDatabase } from "@/lib/db/shared";

/*
 * A figure's derive link at the current release (feature-specs/09 § 6.2,
 * `GET /figures/{id}/derive`; architecture § 3.4: 409 when not derived).
 */

export interface FigureDerive {
  readonly id: string;
  readonly sectionId: string;
  readonly label: string;
  readonly valueText: string;
  readonly tier: "PRIMARY" | "VENDOR" | "ANALYST" | "PRACTITIONER" | "ILLUSTRATIVE" | "DERIVED" | "OPEN" | "SCENARIO";
  readonly derive: { readonly labId: string; readonly filePath: string; readonly line: number; readonly key: string; readonly expression: string } | null;
}

const loadFigure = cached("figure-derive", async (figureId: string): Promise<FigureDerive | null> => {
  const release = await currentRelease();
  const figure = await getPrisma().figure.findFirst({
    where: { anchor: figureId, section: { chapterVersion: { releaseId: release.id } } },
    include: { derive: true, section: { select: { anchor: true } } },
  });
  if (figure === null) return null;
  return {
    id: figure.anchor,
    sectionId: figure.section.anchor,
    label: figure.label,
    valueText: figure.valueText,
    tier: figure.scenarioParam ? "SCENARIO" : figure.tier,
    derive: figure.derive === null ? null : { labId: figure.derive.labId, filePath: figure.derive.filePath, line: figure.derive.line, key: figure.derive.key, expression: figure.derive.expression },
  };
});

export async function getFigureDerive(figureId: string): Promise<FigureDerive | null> {
  requireDatabase();
  return loadFigure(figureId);
}
