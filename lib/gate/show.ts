import type { GoldenItem } from "@/lib/schemas/golden";
import type { GoldenRunItem } from "@/lib/schemas/goldenRun";
import type { Label } from "@/lib/schemas/labels";

/*
 * What `npm run gate:show` prints (feature-specs/22 § 5, D3): one answer of a golden run, laid out for the person
 * who labels it. Pure: the command reads the rows and the files, and these functions say what to print.
 *
 * The one thing it must not print is the grader's reading: no grounding score, no verdict of the grader's, no
 * reason. κ measures the agreement of two independent readings, and a label written after seeing the grader's is
 * a copy of it. The criteria themselves are printed, from the grader's own guide, because both readers must be
 * answering the same four questions.
 */

const CRITERIA_HEADING = "## The four criteria";

/** The grader guide's own statement of its criteria: what stands under that heading, up to the next one. */
export function criteriaOf(graderGuide: string): string | null {
  const lines = graderGuide.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === CRITERIA_HEADING);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** The answers a label can pair with: answered, with a row to name, and graded (a label of an ungraded answer has no second reading). */
export function labellable(items: ReadonlyArray<GoldenRunItem>): ReadonlyArray<GoldenRunItem> {
  return items.filter((item) => item.outcome === "answer" && item.messageId !== null && item.grounded !== null);
}

/** The labellable answers nobody has labelled yet, in the run's order. */
export function unlabelled(items: ReadonlyArray<GoldenRunItem>, labels: ReadonlyArray<Label>): ReadonlyArray<GoldenRunItem> {
  const done = new Set(labels.map((label) => label.messageId));
  return labellable(items).filter((item) => item.messageId !== null && !done.has(item.messageId));
}

/** Where the labelling stands: how many labels pair with this run, of how many the gate needs, and what to read next. */
export function progressText(run: { readonly file: string; readonly grade: string; readonly items: ReadonlyArray<GoldenRunItem> }, labels: ReadonlyArray<Label>, needed: number, labelsFile: string): string {
  const can = labellable(run.items);
  const open = unlabelled(run.items, labels);
  const paired = can.length - open.length;
  const lines = [
    `${run.file} · ${run.grade} · ${String(run.items.length)} items, ${String(can.length)} answered and graded`,
    `labelled ${String(paired)} of the ${String(needed)} the gate needs (${labelsFile}: ${String(labels.length)} line(s), ${String(labels.length - paired)} of them for another run or an answer this run did not grade)`,
  ];
  if (can.length === 0) lines.push("nothing here can be labelled: no answer of this run was graded (the stub's grader gives no verdict; a real run does).");
  else if (open.length === 0) lines.push("every graded answer of this run has a label.");
  else lines.push(`next to read: ${open.slice(0, 10).map((item) => item.id).join(", ")}${open.length > 10 ? `, and ${String(open.length - 10)} more` : ""}`, `  npm run gate:show -- ${open[0]?.id ?? ""}`);
  return lines.join("\n");
}

export interface ShownAnswer {
  readonly conversationId: string;
  /** The answer's claims joined, as the reader saw them; null once the 30-day purge removed the text. */
  readonly text: string | null;
  readonly guideVersion: string | null;
  /** How many claims the citation sensor replaced. The sensor's count, not the grader's reading. */
  readonly substituted: number;
  readonly citations: ReadonlyArray<{ readonly ordinal: number; readonly sectionId: string; readonly figureId: string | null; readonly version: string; readonly editionLang: string; readonly claimText: string | null }>;
}

/** A cited section as the release has it: its title, and each cited figure as the book prints it. */
export interface ShownSection {
  readonly sectionId: string;
  readonly title: string;
  readonly figures: ReadonlyArray<{ readonly figureId: string; readonly label: string; readonly valueText: string }>;
}

/** The label line to complete: every verdict left `null`, so a line pasted unread is refused by the labels' schema. */
export function labelTemplate(record: GoldenRunItem, runFile: string, labeller: Label["labeller"], at: Date): string {
  return JSON.stringify({ goldenId: record.id, runFile, messageId: record.messageId, grounded: null, criteria: { supported: null, precise: null, complete: null, in_scope: null }, labeller, labelledAt: at.toISOString() });
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `  ${line}`))
    .join("\n");
}

function expectedText(item: GoldenItem): string {
  if (item.expected.refusal !== null) return `a refusal, ${item.expected.refusal.cause}`;
  const cites = item.expected.citations.map((citation) => (citation.figureId === null ? citation.sectionId : `${citation.sectionId} ${citation.figureId}`));
  const chapters = item.kind === "compare" ? [`chapters ${item.expected.chapters.join(" and ")}`] : [];
  const value = item.expected.valueText === null ? [] : [`printed as ${item.expected.valueText}`];
  return [...cites, ...chapters, ...value].join(" · ");
}

export interface ShowInput {
  readonly item: GoldenItem;
  readonly record: GoldenRunItem;
  readonly run: { readonly file: string; readonly grade: string };
  /** The answer's row; null when the turn wrote none or the row is gone. */
  readonly answer: ShownAnswer | null;
  readonly sections: ReadonlyArray<ShownSection>;
  /** The grader guide's criteria section and the file it came from; null when the guide of that version is not in the repository. */
  readonly criteria: { readonly text: string; readonly file: string } | null;
  readonly labelsFile: string;
  readonly labeller: Label["labeller"];
  /** The label this answer already has, when it has one. */
  readonly labelled: Label | null;
  /** The stored conversation's page, which shows the same answer as the reader sees it. */
  readonly pageUrl: string | null;
  readonly now: Date;
}

/** One answer, to read and to label. */
export function showText(input: ShowInput): string {
  const { item, record, answer } = input;
  const from = `chapter ${String(item.context.chapter)}${item.context.section === null ? "" : `, section ${item.context.section}`}`;
  const out: string[] = [
    `${item.id} · ${item.kind} · ${item.mode} · ${item.language} · ${input.run.file}`,
    "",
    "question",
    indent(item.question),
    `  asked from ${from}`,
    `  the golden label expects: ${expectedText(item)}`,
    "",
  ];

  if (record.outcome !== "answer") {
    out.push(record.outcome === "refusal" ? `refused · ${record.refusalCause ?? "no cause"}` : `failed · ${record.code ?? "no code"}`, "nothing to label: a label is a reading of an answer.");
    return out.join("\n");
  }
  if (answer === null) {
    out.push(`the answer's row (message ${record.messageId ?? "none"}) is not in this database: the run was made against another one, or the row was deleted.`);
    return out.join("\n");
  }

  out.push(`the answer · message ${record.messageId ?? ""}`);
  if (answer.text === null) {
    out.push("  its text is gone: the purge removes an answer's text after 30 days, and an answer that cannot be read cannot be labelled.");
    return out.join("\n");
  }
  out.push(indent(answer.text));
  if (answer.substituted > 0) out.push(`  (${String(answer.substituted)} claim(s) were replaced by the citation sensor, which could not find what they cited)`);
  out.push("", "what it cites");
  if (answer.citations.length === 0) out.push("  nothing");
  const sections = new Map(input.sections.map((section) => [section.sectionId, section]));
  for (const citation of answer.citations) {
    const section = sections.get(citation.sectionId);
    const figure = citation.figureId === null ? undefined : section?.figures.find((candidate) => candidate.figureId === citation.figureId);
    out.push(`  ${String(citation.ordinal)}. ${citation.sectionId}${citation.figureId === null ? "" : ` ${citation.figureId}`} · ${section?.title ?? "not a section of this release"} · ${citation.version} ${citation.editionLang}`);
    if (citation.claimText !== null) out.push(`     claim: ${citation.claimText}`);
    if (citation.figureId !== null) out.push(figure === undefined ? `     ${citation.figureId} is not a figure of that section in this release` : `     the book prints ${figure.figureId} "${figure.label}" as ${figure.valueText}`);
  }

  out.push("", input.criteria === null ? `the four criteria: the grader's guide of ${answer.guideVersion ?? "this answer"} is not in guides/; read them in the newest guides/assistant/<version>/grader.md` : `the four criteria (${input.criteria.file})`);
  if (input.criteria !== null) out.push(indent(input.criteria.text));

  out.push("", "the label");
  if (record.grounded === null) out.push("  the grader did not grade this answer, so a label of it pairs with nothing: κ needs both readings.");
  if (input.labelled !== null) out.push(`  already labelled by ${input.labelled.labeller} at ${input.labelled.labelledAt}; a second line for the same answer would count twice.`);
  if (input.run.grade === "stub") out.push("  this is a stub answer: it shows the command, and a label of it measures nothing.");
  out.push(`  one line of ${input.labelsFile}, with true or false in place of each null:`, `  ${labelTemplate(record, input.run.file, input.labeller, input.now)}`);
  if (input.pageUrl !== null) out.push("", `the same answer as its reader sees it, signed in as the run's account: ${input.pageUrl}`, "  that page shows the grader's score; read and label here first.");
  return out.join("\n");
}
