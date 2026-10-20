import { expect, test, type Locator, type Page } from "@playwright/test";

import { awake, settled, walkBook } from "./book";
import { CATALOGUES, fill, firstLine, reaches, sectionPath, VIEWPORT, writePart, type Catalogue } from "./support";

/*
 * Every cross-reference opens a peek (unit 23d; project-overview § Success criteria · Phase 1: "Every
 * cross-reference (chNN, NN.N, Lab NN) opens a peek panel without leaving the section, and esc returns focus to
 * the reading position").
 *
 * Every reader page of the book is looked through, and every reference in its prose is clicked: each occurrence,
 * not each target, because the criterion is about the reference a reader meets. For each one the suite records
 * three things:
 *
 *   opened          a peek showed, it is the peek of the target clicked, and the target is in the release
 *   stayed          with the peek open the address is still under the section and the section is still on the
 *                   page; after esc the address is the section's again
 *   focus returned  esc closed the peek, the focus is on the reference that was clicked, and that reference is on
 *                   screen
 *
 * EN only: the prose and its references are the same in both editions of this release, and the peek in PT is part
 * of the read-a-section flow.
 */

test.use({ viewport: VIEWPORT });

const LOCALE = "en";

interface Outcome {
  readonly opened: boolean;
  readonly stayed: boolean;
  readonly returned: boolean;
  /** What went wrong, in a few words; null when nothing did. */
  readonly failure: string | null;
}

function kindOf(target: string): string {
  if (/^ch\d{2}$/.test(target)) return "chapter";
  if (/^lab\d{2}$/.test(target)) return "lab";
  if (/^\d{2}\.[1-9]$/.test(target)) return "section";
  return "other";
}

async function peekAt(page: Page, reference: Locator, target: string, here: string, m: Catalogue): Promise<Outcome> {
  const peek = page.locator(".peek-float");
  try {
    await reference.click({ timeout: 10_000 });
  } catch (error: unknown) {
    return { opened: false, stayed: false, returned: false, failure: `the reference could not be clicked (${firstLine(error)})` };
  }
  if (!(await reaches(peek, "visible", 10_000))) return { opened: false, stayed: false, returned: false, failure: `no peek opened; the reader is at ${new URL(page.url()).pathname}` };

  const open = await peek.evaluate((panel) => ({
    label: panel.getAttribute("aria-label"),
    path: location.pathname,
    missing: panel.querySelector(".empty") !== null,
    section: document.querySelector("h2.section-title") !== null,
  }));
  const opened = open.label === fill(m.reader.peek.label, { id: target }) && !open.missing;
  const under = open.path === `${here}/ref/${target}` && open.section;

  await page.keyboard.press("Escape");
  const closed = await reaches(peek, "hidden", 10_000);
  const back = await page
    .waitForFunction((path) => location.pathname === path, here, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const after = await reference.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { focused: document.activeElement === node, onScreen: box.bottom > 0 && box.top < window.innerHeight };
  });
  const stayed = under && back;
  const returned = closed && after.focused && after.onScreen;

  let failure: string | null = null;
  if (open.missing) failure = "the peek says the target is not in the release";
  else if (!opened) failure = `the peek is "${open.label ?? ""}"`;
  else if (!under) failure = `with the peek open the reader is at ${open.path}`;
  else if (!closed) failure = "esc did not close the peek";
  else if (!back) failure = `after esc the reader is at ${new URL(page.url()).pathname}`;
  else if (!after.focused) failure = "after esc the focus is not on the reference";
  else if (!after.onScreen) failure = "after esc the reference is off screen";
  return { opened, stayed, returned, failure };
}

test(`every cross-reference opens a peek · ${LOCALE}`, async ({ page }) => {
  test.setTimeout(90 * 60_000);
  const m = CATALOGUES[LOCALE];
  const targets = new Set<string>();
  const failures: string[] = [];
  let sections = 0;
  let references = 0;
  let opened = 0;
  let stayed = 0;
  let focusReturned = 0;

  try {
    await walkBook(page, LOCALE, m, {
      visit: async (at) => {
        sections += 1;
        const here = sectionPath(LOCALE, at.section);
        const links = page.locator(".prose a.xref[data-ref]");
        const found = await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-ref") ?? ""));
        for (const [index, target] of found.entries()) {
          references += 1;
          targets.add(target);
          const outcome = await peekAt(page, links.nth(index), target, here, m);
          opened += outcome.opened ? 1 : 0;
          stayed += outcome.stayed ? 1 : 0;
          focusReturned += outcome.returned ? 1 : 0;
          if (outcome.failure === null) continue;
          failures.push(`${at.section} → ${target} (reference ${String(index + 1)} of ${String(found.length)}): ${outcome.failure}`);
          /* Whatever state the failure left, the next reference is clicked on the section, with its code live. */
          await page.goto(here);
          await settled(page, at.section);
          await awake(page, m);
        }
      },
    });
  } catch (error: unknown) {
    failures.push(firstLine(error));
    throw error;
  } finally {
    const kinds: Record<string, number> = {};
    for (const target of targets) kinds[kindOf(target)] = (kinds[kindOf(target)] ?? 0) + 1;
    writePart({ kind: "peek", locale: LOCALE, sections, references, targets: targets.size, kinds, opened, stayed, focusReturned, failures: failures.slice(0, 50) });
  }
  expect(failures, "references whose peek did not open, stay or give the focus back").toEqual([]);
});
