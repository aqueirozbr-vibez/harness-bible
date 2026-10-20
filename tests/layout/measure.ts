import type { LayoutFinding } from "@/lib/schemas/layout";

/*
 * What "truncated" means, measured in the page (ui-context § 11: "Wrap, never truncate"; § 13.7 forbids
 * `text-overflow: ellipsis`, `truncate` and `line-clamp` on any label). Run with the padded PT catalogue, the
 * rendered document is asked five things of every element that holds text:
 *
 *   ellipsis            it elides its text with an ellipsis
 *   line-clamp          it clamps its lines
 *   clipped             it hides overflow sideways and its content is wider than it: a header whose last part is cut off
 *   clipped-vertically  it hides overflow downwards and its content is taller: a wrapped label in a bar of fixed height
 *   spills              its own text is wider than it and nothing hides it: a status mark running out of its tile
 *
 * and one thing of the page: whether it scrolls sideways, and which elements stick out of the viewport.
 *
 * A scrolling box (`overflow: auto`) is not truncation: a code pane scrolls and says so with its scrollbar. An
 * element of one pixel is the screen reader's, not the eye's.
 *
 * This function is serialised into the page by `page.evaluate`, so it closes over nothing.
 */
export function measureLayout(): { readonly labels: number; readonly findings: ReadonlyArray<LayoutFinding> } {
  const SLACK = 1;
  const findings: LayoutFinding[] = [];
  const nameOf = (element: Element): string => {
    const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).filter((entry) => entry !== "") : [];
    return [element.tagName.toLowerCase(), ...classes.slice(0, 3)].join(".");
  };
  const textOf = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const ownText = (element: Element): boolean => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? "").trim() !== "");
  const add = (kind: LayoutFinding["kind"], element: Element, by: number): void => {
    findings.push({ kind, element: nameOf(element), text: textOf(element), by: Math.round(by) });
  };

  let labels = 0;
  for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
    /* The framework's own development overlay is not the product's. */
    if (element.closest("script, style, noscript, svg, nextjs-portal, [hidden]") !== null) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.display === "inline" || style.display === "contents" || style.visibility === "hidden") continue;
    const box = element.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) continue;
    if ((element.textContent ?? "").trim() === "") continue;
    labels += 1;

    const hidesX = /hidden|clip/.test(style.overflowX);
    const hidesY = /hidden|clip/.test(style.overflowY);
    const scrollsX = /auto|scroll/.test(style.overflowX);
    const wider = element.scrollWidth - element.clientWidth;
    const taller = element.scrollHeight - element.clientHeight;

    if (style.textOverflow === "ellipsis" && wider > 0) add("ellipsis", element, wider);
    const clamp = style.getPropertyValue("-webkit-line-clamp");
    if (clamp !== "" && clamp !== "none") add("line-clamp", element, 0);
    if (hidesX && wider > SLACK) add("clipped", element, wider);
    if (hidesY && taller > SLACK) add("clipped-vertically", element, taller);
    if (!hidesX && !scrollsX && wider > SLACK && ownText(element)) add("spills", element, wider);
  }

  /* The page itself: it must not scroll sideways. The elements named are the innermost that stick out of the viewport. */
  const viewport = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > viewport + SLACK) {
    /* What widens the page is what no ancestor contains: content inside a box that scrolls or hides its own
       overflow sticks out of that box, not of the page. */
    const contained = (element: Element): boolean => {
      for (let parent = element.parentElement; parent !== null && parent !== document.body; parent = parent.parentElement) {
        if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowX)) return true;
      }
      return false;
    };
    const out = [...document.body.querySelectorAll<HTMLElement>("*")].filter((element) => {
      if (element.closest("nextjs-portal") !== null) return false;
      const box = element.getBoundingClientRect();
      return box.width > 1 && box.height > 1 && box.right > viewport + SLACK && getComputedStyle(element).position !== "fixed" && !contained(element);
    });
    const innermost = out.filter((element) => !out.some((other) => other !== element && element.contains(other)));
    if (innermost.length === 0) findings.push({ kind: "page-overflow", element: "html", text: "", by: document.documentElement.scrollWidth - viewport });
    for (const element of innermost.slice(0, 5)) add("page-overflow", element, element.getBoundingClientRect().right - viewport);
  }

  return { labels, findings };
}
