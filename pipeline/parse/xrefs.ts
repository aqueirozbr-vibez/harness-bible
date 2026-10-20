/*
 * Cross-references in prose (feature-specs/04 § 5, xrefs.ts): chNN, Lab NN,
 * NN.k sections and NN.9 rK source rows → CrossReference rows and links in
 * the HTML. Runs on rendered HTML, on text segments outside chips and links.
 */

export interface CrossRef {
  readonly targetKind: "section" | "chapter" | "lab" | "sourceRow";
  readonly targetId: string;
}

export interface XrefPassResult {
  readonly html: string;
  readonly refs: ReadonlyArray<CrossRef>;
}

/* One pass, one regex: a source row ("21.9 r4") must win over the section it starts with ("21.9"). */
const REF_RE = /\b(\d{2})\.9 r(\d+)\b|\b(\d{2})\.([1-9])\b|\bch(\d{2})\b|\bLab (\d{2})\b/g;
const LAST_CHAPTER = 40;

function isTag(segment: string): boolean {
  return segment.startsWith("<");
}

/** Split HTML into alternating text and tag segments, marking text inside protected elements. */
function segments(html: string): Array<{ text: string; tag: boolean; protectedDepth: number }> {
  const out: Array<{ text: string; tag: boolean; protectedDepth: number }> = [];
  let depth = 0;
  const stack: boolean[] = [];
  for (const part of html.split(/(<[^>]+>)/g)) {
    if (part.length === 0) continue;
    if (isTag(part)) {
      const closing = part.startsWith("</");
      const selfClosing = part.endsWith("/>") || /^<(br|img|hr)\b/i.test(part);
      if (!closing && !selfClosing) {
        const prot = /class="(?:chip|derive|xref|src|code|code-h|code-b|ln|fig)\b/.test(part) || /^<(a|template|svg)\b/i.test(part);
        stack.push(prot);
        if (prot) depth += 1;
      } else if (closing) {
        const wasProt = stack.pop() ?? false;
        if (wasProt) depth -= 1;
      }
      out.push({ text: part, tag: true, protectedDepth: depth });
    } else {
      out.push({ text: part, tag: false, protectedDepth: depth });
    }
  }
  return out;
}

export function xrefPass(html: string, locale: string, currentChapter: number): XrefPassResult {
  const refs = new Map<string, CrossRef>();
  const add = (kind: CrossRef["targetKind"], id: string) => {
    refs.set(`${kind}:${id}`, { targetKind: kind, targetId: id });
  };
  const rewritten = segments(html)
    .map((seg) => {
      if (seg.tag || seg.protectedDepth > 0) return seg.text;
      const xref = (m: string, id: string): string => `<a class="xref" href="/${locale}/ref/${id}" data-ref="${id}">${m}</a>`;
      return seg.text.replace(REF_RE, (m: string, rowCh?: string, rowN?: string, secCh?: string, secK?: string, ch?: string, lab?: string) => {
        if (rowCh !== undefined && rowN !== undefined) {
          if (Number(rowCh) > LAST_CHAPTER) return m;
          const id = `${rowCh}.9 r${rowN}`;
          add("sourceRow", id);
          return Number(rowCh) === currentChapter ? `<a class="src" href="#r${rowN}" data-row="${id}">${m}</a>` : xref(m, `${rowCh}.9`);
        }
        if (secCh !== undefined && secK !== undefined) {
          if (Number(secCh) > LAST_CHAPTER) return m;
          const id = `${secCh}.${secK}`;
          add("section", id);
          return xref(m, id);
        }
        if (ch !== undefined) {
          if (Number(ch) > LAST_CHAPTER) return m;
          add("chapter", `ch${ch}`);
          return xref(m, `ch${ch}`);
        }
        if (lab !== undefined) {
          if (Number(lab) > LAST_CHAPTER) return m;
          add("lab", `lab${lab}`);
          return xref(m, `lab${lab}`);
        }
        return m;
      });
    })
    .join("");
  return { html: rewritten, refs: [...refs.values()] };
}
