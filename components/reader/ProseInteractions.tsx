"use client";

import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

import { STATUS_EVENT } from "@/components/chrome/StatusNote";
import type { CodeBlockView } from "@/lib/schemas/chapter";

/** Window event a figures-table row sends to highlight its figure in the prose. */
export const FIGURE_EVENT = "hb:figure";

/** Attribute set on the cross-reference the peek was opened from, so the panel can anchor to it and return focus. */
export const PEEK_ANCHOR_ATTR = "data-peek-anchor";

const FLASH_MS = 1500;

interface ProseInteractionsProps {
  readonly codeBlocks: ReadonlyArray<CodeBlockView>;
  readonly children: ReactNode;
}

function flash(el: Element): void {
  el.classList.add("flash");
  window.setTimeout(() => el.classList.remove("flash"), FLASH_MS);
}

/**
 * Wires the static section HTML (spec § 6.4): injects the code-pane buttons,
 * routes cross-reference clicks to the peek route, scrolls derive chips to
 * their line, and highlights a figure when the figures table asks.
 */
export function ProseInteractions({ codeBlocks, children }: ProseInteractionsProps) {
  const t = useTranslations("reader.code");
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const basePath = pathname.replace(/\/ref\/[^/]+$/, "");
  const labels = { copy: t("copy"), copyLabel: t("copyLabel"), copied: t("copied"), open: t("open"), region: t("region") };

  useEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const created: HTMLElement[] = [];

    root.querySelectorAll<HTMLElement>(".code").forEach((pane, index) => {
      const head = pane.querySelector<HTMLElement>(".code-h");
      /* The code body scrolls sideways, so it must take keyboard focus and say what it is (WCAG 2.1.1; ui-context § 9.5:
         a code region names its file and range). The stored HTML predates this; the pipeline should emit it at the next ingest. */
      const body = pane.querySelector<HTMLElement>(".code-b");
      if (body !== null && !body.hasAttribute("tabindex")) {
        body.tabIndex = 0;
        body.setAttribute("role", "region");
        body.setAttribute("aria-label", head?.querySelector("span")?.textContent?.trim() || labels.region);
      }
      if (head === null) return;
      const meta = codeBlocks[index];
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "btn btn-sm btn-q";
      copy.textContent = labels.copy;
      copy.setAttribute("aria-label", labels.copyLabel);
      copy.addEventListener("click", () => {
        const template = pane.querySelector<HTMLTemplateElement>("template[data-raw]");
        const raw = template?.content.textContent ?? pane.querySelector(".code-b")?.textContent ?? "";
        navigator.clipboard
          .writeText(raw)
          .then(() => window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: labels.copied })))
          .catch(() => undefined);
      });
      head.appendChild(copy);
      created.push(copy);
      if (meta !== undefined && meta.labHref !== null) {
        const open = document.createElement("a");
        open.className = "btn btn-sm";
        open.href = meta.labHref;
        open.textContent = labels.open;
        head.appendChild(open);
        created.push(open);
      }
    });

    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const xref = target?.closest<HTMLAnchorElement>("a.xref[data-ref]");
      if (xref !== null && xref !== undefined && root.contains(xref)) {
        event.preventDefault();
        root.querySelectorAll(`[${PEEK_ANCHOR_ATTR}]`).forEach((el) => el.removeAttribute(PEEK_ANCHOR_ATTR));
        xref.setAttribute(PEEK_ANCHOR_ATTR, "");
        router.push(`${basePath}/ref/${xref.dataset.ref}`);
        return;
      }
      const derive = target?.closest<HTMLAnchorElement>("a.derive[data-line]");
      if (derive !== null && derive !== undefined && root.contains(derive)) {
        const line = root.querySelector<HTMLElement>(`.ln[data-n="${derive.dataset.line}"]`);
        if (line !== null) {
          event.preventDefault();
          line.scrollIntoView({ block: "center" });
          flash(line);
        }
      }
    };
    root.addEventListener("click", onClick);

    const onFigure = (event: Event) => {
      const id = (event as CustomEvent<{ id: string | null }>).detail.id;
      if (id === null) return;
      const el = root.querySelector<HTMLElement>(`[data-figure="${id}"]`);
      if (el === null) return;
      el.scrollIntoView({ block: "center" });
      flash(el);
    };
    window.addEventListener(FIGURE_EVENT, onFigure);

    return () => {
      created.forEach((el) => el.remove());
      root.removeEventListener("click", onClick);
      window.removeEventListener(FIGURE_EVENT, onFigure);
    };
  }, [codeBlocks, router, basePath, labels.copy, labels.copyLabel, labels.copied, labels.open, labels.region]);

  return <div ref={ref}>{children}</div>;
}
