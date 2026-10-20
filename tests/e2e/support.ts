import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type Response } from "@playwright/test";

import en from "../../messages/en.json";
import pt from "../../messages/pt.json";

import { E2E_LOCALES, E2ePartSchema, type AxeFinding, type E2eFlowId, type E2eLocale, type E2ePart } from "@/lib/schemas/e2e";

/*
 * What the end-to-end specs share (unit 23d): the two catalogues, the dev sign-in, the axe scan, and the part each
 * test leaves on disk.
 *
 * A flow is written once and run in EN and in PT. It finds its controls by role and by the catalogue's own words
 * for that language, as a reader would, and by the classes ui-context documents where a control has no words of
 * its own; a string that changes in the catalogue changes here with it.
 *
 * Nothing here asks the assistant a question: an answer is a model call, and a suite that anyone may run spends
 * nothing.
 */

export type Catalogue = typeof en;
export const CATALOGUES: Readonly<Record<E2eLocale, Catalogue>> = { en, pt };

/** The desktop width the design system names (ui-context § 14.5): the reader's three columns are all on screen. */
export const VIEWPORT = { width: 1440, height: 900 } as const;

/** The suite's own reader, made by the dev sign-in on first use: its marks and its progress are the suite's to write and to clear. */
export const READER = "e2e-reader@harness-bible.local";

/**
 * What the dev sign-in is asked to say of an account, where the identity provider would (feature-specs/29 § 6.4):
 * a member left out leaves the account as it is, and a new account is a reader, not verified.
 */
export interface DevIdentity {
  readonly role?: "READER" | "BUILDER" | "CONTRIBUTOR" | "CURATOR" | "ORG_ADMIN";
  readonly verified?: boolean;
}

export interface Account extends DevIdentity {
  readonly email: string;
}

/**
 * The suite's own contributor and curator (unit 46e), after the pattern of its reader: made by the dev sign-in on
 * first use, verified, and the suite's to write suggestions and decisions as. The dev sign-in puts a curator it is
 * asked for on the roster for every part (feature-specs/29 § 17); a flow that needs a curator of some parts only sets
 * the rows' ends with `npm run roster:set`.
 */
export const CONTRIBUTOR: Account = { email: "e2e-contributor@harness-bible.local", role: "CONTRIBUTOR", verified: true };
export const CURATOR: Account = { email: "e2e-curator@harness-bible.local", role: "CURATOR", verified: true };

/** The suite's account whose role is the suite's to switch (the account page's role switch, feature-specs/29 § 16): no other spec relies on what it is. */
export const SWITCHER = "e2e-roles@harness-bible.local";

/** Where the parts are left: under the runner's output folder, which it empties before every run. */
export const PARTS_DIR = join("test-results", "e2e-parts");
const SESSIONS_DIR = join("test-results", "e2e-sessions");

/** WCAG 2.2 AA, the release gate of ui-context § 12. */
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export function writePart(part: E2ePart): void {
  const parsed = E2ePartSchema.parse(part);
  mkdirSync(PARTS_DIR, { recursive: true });
  const name = parsed.kind === "flow" ? `flow-${parsed.id}-${parsed.locale}` : parsed.kind === "resume" ? `resume-${parsed.path}` : `${parsed.kind}-${parsed.locale}`;
  writeFileSync(join(PARTS_DIR, `${name}.json`), `${JSON.stringify(parsed, null, 2)}\n`);
}

/**
 * The page as it stands, scanned for WCAG 2.2 AA violations. The framework's development overlay is not the product's.
 * `within`, a selector, scans those regions alone: a case about one part of a screen another case scans whole.
 */
export async function axeFindings(page: Page, screen: string, within?: string): Promise<ReadonlyArray<AxeFinding>> {
  const builder = new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal");
  const results = await (within === undefined ? builder : builder.include(within)).analyze();
  return results.violations.map((violation) => ({ screen, rule: violation.id, nodes: violation.nodes.length, target: violation.nodes[0]?.target.join(" ") ?? "" }));
}

/** Sign the context in as `email` through the dev provider, as the role and verification given if any, and land on `next` (feature-specs/08 § 5.7, 29 § 6.4; refused in production). */
export async function signIn(page: Page, email: string, next: string, as: DevIdentity = {}): Promise<void> {
  const identity = `${as.role === undefined ? "" : `&role=${as.role}`}${as.verified === undefined ? "" : `&verified=${String(as.verified)}`}`;
  const response = await page.goto(`/api/v1/auth/dev?email=${encodeURIComponent(email)}${identity}&next=${encodeURIComponent(next)}`);
  expect(response?.status() ?? 0, "the dev sign-in needs a development server (AUTH_DEV_PROVIDER=1)").toBeLessThan(400);
}

type Cookies = Awaited<ReturnType<BrowserContext["cookies"]>>;

/**
 * A session of the suite's reader, by name: one dev sign-in per name and per run, because the endpoint allows ten a
 * minute. It is kept on disk, since a failed test costs the runner its worker and everything the worker remembered.
 * Two names are two sessions of one account, which is what two devices are.
 */
export function readerSession(browser: Browser, baseURL: string | undefined, name: string): Promise<Cookies> {
  return accountSession(browser, baseURL, name, { email: READER });
}

/** A session of one of the suite's accounts, by name, kept as the reader's is. The name is the session's: two accounts take two names. */
export async function accountSession(browser: Browser, baseURL: string | undefined, name: string, account: Account): Promise<Cookies> {
  const file = join(SESSIONS_DIR, `${name}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Cookies;
  const context = await browser.newContext({ baseURL });
  try {
    await signIn(await context.newPage(), account.email, "/en", account);
    const cookies = await context.cookies();
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(cookies));
    return cookies;
  } finally {
    await context.close();
  }
}

export function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}

/** A catalogue string with its placeholders filled. Only the plain `{name}` form: a plural or a select is matched by its parts instead. */
export function fill(template: string, values: Readonly<Record<string, string | number>> = {}): string {
  if (/\{\s*\w+\s*,/.test(template)) throw new Error(`"${template}" is a plural or a select: match it by its parts`);
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

/** The words of a catalogue string before its first placeholder: `saved {when}` → `saved`. */
export function stem(template: string): string {
  return (template.split("{")[0] ?? "").trim();
}

/** The section a reader URL names: `/en/ch/21/21.3?x=1` → `21.3`; null for any other page. */
export function sectionOf(url: string): string | null {
  return /\/ch\/\d{2}\/(\d{2}\.[1-9])$/.exec(new URL(url, "http://localhost").pathname)?.[1] ?? null;
}

/** The reader page of a section: `21.3` in `en` → `/en/ch/21/21.3`. */
export function sectionPath(locale: E2eLocale, section: string): string {
  return `/${locale}/ch/${section.slice(0, 2)}/${section}`;
}

/** A URL test for `waitForURL` that reads the path alone, whatever the query. */
export function onPath(path: string): (url: URL) => boolean {
  return (url) => url.pathname === path;
}

/**
 * A write the page posts to the server (a server action), by something its body carries: resolves when the server
 * has answered. Asked for before the key or the click that causes it.
 */
export function serverAction(page: Page, carrying: string, timeout = 40_000): Promise<Response> {
  return page.waitForResponse(
    (response) => {
      const request = response.request();
      return request.method() === "POST" && request.headers()["next-action"] !== undefined && (request.postData() ?? "").includes(carrying);
    },
    { timeout },
  );
}

/**
 * The reader's "this section was read" write (feature-specs/05 § 5.3): sent once the reader has stayed on the
 * section or has left it, so the wait covers the dwell.
 */
export function readRecorded(page: Page, section: string): Promise<Response> {
  return serverAction(page, `"sectionId":"${section}"`);
}

/** Whether the locator reaches the state in time: a measurement, where `expect` would end the test. */
export async function reaches(locator: Locator, state: "visible" | "hidden", timeout = 5_000): Promise<boolean> {
  try {
    await locator.waitFor({ state, timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a dialog from its trigger. The trigger is a client component's: on a page that has just loaded, a click
 * before it is live does nothing, so the click is repeated until the dialog is there.
 */
export async function openDialog(trigger: Locator, dialog: Locator): Promise<void> {
  await expect(async () => {
    if (!(await dialog.isVisible())) await trigger.click({ timeout: 2_000 });
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

export interface FlowContext {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly locale: E2eLocale;
  /** The catalogue of the flow's language. */
  readonly m: Catalogue;
  /** Scan the page as it stands; what axe finds fails the flow at its end, after every screen has been seen. */
  readonly scan: (screen: string) => Promise<void>;
}

/**
 * One of the reader's primary flows, in EN and in PT. Whatever happens, the flow's part is written: that it ran,
 * whether it passed, why not, and what axe found on each screen it scanned.
 */
export function defineFlow(id: E2eFlowId, options: { readonly signedIn: boolean }, body: (flow: FlowContext) => Promise<void>): void {
  for (const locale of E2E_LOCALES) {
    test(`${id} · ${locale}`, async ({ page, context, browser, baseURL }) => {
      const axe: AxeFinding[] = [];
      let screens = 0;
      let failure: string | null = null;
      const scan = async (screen: string): Promise<void> => {
        screens += 1;
        axe.push(...(await axeFindings(page, screen)));
      };
      try {
        if (options.signedIn) await context.addCookies(await readerSession(browser, baseURL, "flows"));
        await body({ page, context, locale, m: CATALOGUES[locale], scan });
      } catch (error: unknown) {
        failure = firstLine(error);
        throw error;
      } finally {
        const violations = axe.length === 0 ? null : `${String(axe.length)} axe violation${axe.length === 1 ? "" : "s"}: ${axe.map((finding) => `${finding.rule} on ${finding.screen}`).join("; ")}`;
        writePart({ kind: "flow", id, locale, passed: failure === null && axe.length === 0, failure: failure ?? violations, screens, axe });
      }
      expect(
        axe.map((finding) => `${finding.screen}: ${finding.rule} (${String(finding.nodes)}) ${finding.target}`),
        "axe violations",
      ).toEqual([]);
    });
  }
}
