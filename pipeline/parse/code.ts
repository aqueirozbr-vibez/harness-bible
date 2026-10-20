import { escapeHtml, type Fence } from "./markdown";

/*
 * Fenced code → `.code` panes (feature-specs/04 § 6.5). Lab files are
 * recognised by content: the block's first lines are searched in the lab's
 * files, and matching blocks are numbered from their real line.
 */

export interface LabFileText {
  readonly path: string;
  readonly content: string;
}

export interface CodeBlockView {
  readonly index: number;
  readonly file: string | null;
  readonly lines: { readonly from: number; readonly to: number } | null;
  readonly language: string;
  readonly labHref: string | null;
}

export interface CodePane {
  readonly html: string;
  readonly view: CodeBlockView;
}

const PY_KEYWORDS = /\b(def|return|if|else|elif|for|while|in|not|and|or|import|from|as|class|try|except|finally|with|lambda|yield|pass|break|continue|raise|True|False|None|is|del|global|nonlocal|assert|async|await)\b/g;

function highlightPython(line: string): string {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 0) {
    const comment = rest.indexOf("#");
    const str = rest.search(/["']/);
    if (comment >= 0 && (str < 0 || comment < str)) {
      parts.push(highlightCode(rest.slice(0, comment)));
      parts.push(`<span class="c">${escapeHtml(rest.slice(comment))}</span>`);
      break;
    }
    if (str >= 0) {
      const quote = rest[str];
      const end = rest.indexOf(quote, str + 1);
      const stop = end < 0 ? rest.length : end + 1;
      parts.push(highlightCode(rest.slice(0, str)));
      parts.push(`<span class="s">${escapeHtml(rest.slice(str, stop))}</span>`);
      rest = rest.slice(stop);
      continue;
    }
    parts.push(highlightCode(rest));
    break;
  }
  return parts.join("");
}

function highlightCode(text: string): string {
  return escapeHtml(text)
    .replace(PY_KEYWORDS, '<span class="k">$1</span>')
    .replace(/(<span class="k">def<\/span>\s+)([A-Za-z_]\w*)/g, '$1<span class="fn">$2</span>')
    .replace(/\b(\d[\d_]*(?:\.\d+)?)\b/g, '<span class="s">$1</span>');
}

/** Find the block's first three non-empty lines inside a lab file; returns the 1-based line of the first. */
export function locateInLab(text: string, files: ReadonlyArray<LabFileText>): { path: string; line: number } | null {
  const probe = text.split("\n").filter((l) => l.trim().length > 0).slice(0, 3);
  if (probe.length === 0) return null;
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trimEnd() !== probe[0].trimEnd()) continue;
      let ok = true;
      let j = i;
      for (const p of probe) {
        while (j < lines.length && lines[j].trim().length === 0) j += 1;
        if (j >= lines.length || lines[j].trimEnd() !== p.trimEnd()) {
          ok = false;
          break;
        }
        j += 1;
      }
      if (ok) return { path: file.path, line: i + 1 };
    }
  }
  return null;
}

export function renderCodePane(
  fence: Fence,
  opts: { readonly locale: string; readonly labId: string | null; readonly labFiles: ReadonlyArray<LabFileText>; readonly highlightLines: ReadonlySet<number> },
): CodePane {
  const located = fence.lang === "python" && opts.labId !== null ? locateInLab(fence.text, opts.labFiles) : null;
  const lines = fence.text.split("\n");
  const from = located?.line ?? 1;
  const file = located === null ? null : `${opts.labId}/${located.path}`;
  const labHref = located === null || opts.labId === null ? null : `/${opts.locale}/labs/${opts.labId}/${located.path}#L${from}`;
  const body = lines
    .map((l, i) => {
      const n = from + i;
      const hl = opts.highlightLines.has(n) && located !== null ? " hl" : "";
      const content = fence.lang === "python" ? highlightPython(l) : escapeHtml(l);
      return `<span class="ln${hl}" data-n="${n}" id="ln-${fence.index}-${n}">${content}</span>`;
    })
    .join("");
  const label = file ?? fence.lang;
  const meta = located === null ? fence.lang : `· lines ${from}–${from + lines.length - 1} · ${fence.lang}`;
  const html = `<div class="code" data-block="${fence.index}" id="code-${fence.index}"><div class="code-h"><span>${escapeHtml(label)}</span><span class="faint">${escapeHtml(meta)}</span><span class="grow"></span></div><div class="code-b">${body}</div><template data-raw>${escapeHtml(fence.text)}</template></div>`;
  return { html, view: { index: fence.index, file, lines: located === null ? null : { from, to: from + lines.length - 1 }, language: fence.lang, labHref } };
}
