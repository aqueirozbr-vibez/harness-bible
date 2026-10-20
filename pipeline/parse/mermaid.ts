import { createRequire } from "node:module";

import { escapeHtml, type Fence } from "./markdown";

/*
 * Mermaid → inline SVG at ingestion (feature-specs/04 § 6.6). The browser is
 * the installed Edge driven by Playwright; the app never renders Mermaid at
 * request time. Colours come from globals.css rules on `.fig svg` classes,
 * so the SVG's own <style> and inline styles are removed.
 */

export interface MermaidFigure {
  readonly html: string;
  readonly id: string;
}

export interface MermaidRenderer {
  render(definitions: ReadonlyArray<string>): Promise<ReadonlyArray<string | null>>;
  close(): Promise<void>;
}

const require = createRequire(import.meta.url);

/**
 * Mermaid reads `;` as a statement separator, so a sequence-diagram note or
 * message containing one ("worker killed here; new worker replays H") fails to
 * parse. The text after the first colon of such lines has it escaped as `#59;`,
 * which renders as a semicolon. The definition stored in the hash is the book's.
 */
export function prepareDefinition(definition: string): string {
  if (!/^\s*sequenceDiagram/.test(definition)) return definition;
  return definition
    .split("\n")
    .map((line) => {
      const colon = line.indexOf(":");
      if (colon < 0 || !/^\s*(Note\b|[A-Za-z_]\w*\s*(-->>?|->>?|-[x)]|--[x)]))/.test(line)) return line;
      return line.slice(0, colon + 1) + line.slice(colon + 1).replace(/;/g, "#59;");
    })
    .join("\n");
}

/** Launch one page with mermaid loaded; render many definitions through it. */
export async function createMermaidRenderer(): Promise<MermaidRenderer> {
  const { chromium } = await import("@playwright/test");
  const mermaidPath = require.resolve("mermaid/dist/mermaid.min.js");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ path: mermaidPath });
  await page.evaluate(() => {
    (window as unknown as { mermaid: { initialize: (c: unknown) => void } }).mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      /* IBM Plex Mono is not installed in the rendering browser; Courier New shares its 0.6em advance width,
         so boxes measured here fit the reader's font */
      fontFamily: "Courier New, monospace",
      /* labels as <text>, never <foreignObject>: the top-level flag is the one the unified renderer reads */
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      sequence: { useMaxWidth: true, wrap: true },
    });
  });
  return {
    async render(definitions) {
      const out: Array<string | null> = [];
      for (let i = 0; i < definitions.length; i += 1) {
        try {
          const svg = await page.evaluate(
            async ({ def, id }) => {
              const m = (window as unknown as { mermaid: { render: (id: string, def: string) => Promise<{ svg: string }> } }).mermaid;
              const result = await m.render(id, def);
              return result.svg;
            },
            { def: prepareDefinition(definitions[i]), id: `m${i}` },
          );
          out.push(svg);
        } catch (error) {
          console.warn(`mermaid: diagram ${i + 1} of ${definitions.length} failed: ${(error as Error).message.split("\n")[0]}`);
          out.push(null);
        }
      }
      return out;
    },
    async close() {
      await browser.close();
    },
  };
}

/** Strip styles, scripts and foreign content; keep presentation attributes and classes for globals.css. */
export function cleanSvg(svg: string, titleId: string, descId: string, title: string, desc: string): string {
  let s = svg;
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  /* effects the reader vocabulary does not carry: filters, gradients, patterns, masks and their references */
  s = s.replace(/<(filter|linearGradient|radialGradient|pattern|mask|clipPath)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/\s(filter|mask|clip-path)="[^"]*"/gi, "");
  s = s.replace(/\s(fill|stroke)="url\(#[^)]*\)"/gi, "");
  s = s.replace(/\sstyle="[^"]*"/g, "");
  s = s.replace(/\son[a-z]+="[^"]*"/gi, "");
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1");
  s = s.replace(/<svg\b([^>]*)>/i, (m, attrs: string) => {
    const kept = attrs.replace(/\s(width|height|style)="[^"]*"/g, "").replace(/\saria-roledescription="[^"]*"/g, "");
    return `<svg${kept} width="100%" role="img" aria-labelledby="${titleId} ${descId}"><title id="${titleId}">${escapeHtml(title)}</title><desc id="${descId}">${escapeHtml(desc)}</desc>`;
  });
  return s;
}

function labelsOf(definition: string): string {
  const labels = [...definition.matchAll(/\[([^\]]+)\]|\(\(([^)]+)\)\)|\{([^}]+)\}|"([^"]+)"/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]).filter((l) => l.length > 0);
  return labels.slice(0, 8).join(" → ");
}

/** Wrap a rendered SVG in the reader's figure frame. */
export function figureHtml(fence: Fence, svg: string | null, chapter: number, figureOrdinal: number, figureId: string, labels: { readonly figure: string; readonly rendered: string; readonly alt: string; readonly notRendered: string }): string {
  const number = `${String(chapter).padStart(2, "0")}.${figureOrdinal}`;
  const title = `${labels.figure} ${number}`;
  const desc = fence.caption ?? labelsOf(fence.text);
  const body = svg === null ? `<p class="small muted">${escapeHtml(labels.notRendered)}</p>` : cleanSvg(svg, `f-${chapter}-${figureOrdinal}-t`, `f-${chapter}-${figureOrdinal}-d`, title, desc);
  const caption = fence.caption === null ? "" : `<figcaption class="small muted rt">${escapeHtml(fence.caption)}</figcaption>`;
  return `<figure class="fig box" data-figure="${figureId}"><div class="inst-h"><span class="t">${escapeHtml(title)}</span><span class="sep">·</span><span>${escapeHtml(labels.rendered)}</span><span class="ts">${escapeHtml(labels.alt)}</span></div>${body}<p class="sr-only">${escapeHtml(desc)}</p>${caption}</figure>`;
}
