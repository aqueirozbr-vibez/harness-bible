/*
 * The linter's word count (bible/scripts/lint_chapter.py): prose plus tables,
 * with code fences, display and inline math excluded.
 */

export interface WordCount {
  readonly prose: number;
  readonly tables: number;
  readonly total: number;
}

export function countWords(markdown: string): WordCount {
  const noCode = markdown.replace(/```[\s\S]*?```/g, "");
  let body = noCode.replace(/\$\$[\s\S]*?\$\$/g, "");
  body = body.replace(/\$(?!\d)[^$\n]*?\$(?!\d)/g, "");
  const tableLines = noCode.split(/\r?\n/).filter((l) => /^\|/.test(l));
  body = body.replace(/^\|.*$/gm, "");
  const prose = body.split(/\s+/).filter((w) => w.length > 0).length;
  const tables = tableLines.join(" ").split(/\s+/).filter((w) => w.length > 0).length;
  return { prose, tables, total: prose + tables };
}
