import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import en from "../../messages/en.json";
import pt from "../../messages/pt.json";

import { FIXTURE_HEADER, fixtureStats, padCatalogue, PADDED_FIXTURE, type Messages } from "@/lib/i18n/pad";
import { truncationReportName, type LayoutScreen, type TruncationReport } from "@/lib/schemas/layout";

import { measureLayout } from "./measure";

/*
 * The PT label truncation suite (unit 23c; project-overview § Success criteria · Phase 1: "a PT label truncation
 * snapshot suite passes with every string at least 30% longer than its EN counterpart in the fixture"; § Features:
 * "PT strings budgeted 30% longer than EN; labels wrap, never truncate").
 *
 * The primary screens are rendered in Portuguese with the padded catalogue (lib/i18n/pad.ts), at the two widths the
 * design system names (ui-context § 14.5: 1440 and 390), and each is measured in the page for a label that is
 * elided, clamped, clipped or spilling, and for a page that scrolls sideways (tests/layout/measure.ts).
 *
 * The snapshot is of the layout's facts, not of its pixels: per screen and width, how many labels were measured and
 * every one that failed, written to pipeline/reports/ where the Phase 1 gate reads it. Pixels differ between two
 * machines' fonts and say nothing a count of clipped labels does not; a truncated label is a fact of the DOM.
 *
 * It is one test on purpose. A runner discards its worker after a failed test, and the report must hold every
 * screen whether the first one failed or not: so every screen is measured, the report is written, and then the
 * suite passes or fails once, naming each finding.
 *
 * Run it against a development server (`npm run test:layout`): the padded catalogue and the dev sign-in are both
 * refused in production.
 */

const DEMO = "demo@harness-bible.local";
/* The suggest form is a verified contributor's (feature-specs/34 § 7): the demo account would see its role notice. */
const CONTRIBUTOR = "layout-contributor@harness-bible.local";
/* The curator queue is a curator's (feature-specs/36 § 4): the dev sign-in puts this account on the roster for every part (29 § 17). */
const CURATOR = "layout-curator@harness-bible.local";
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

interface Screen {
  readonly id: string;
  /** The page; `{draft}` is the id of the contributor's draft made for the screens that need one, `{researchSeed}` the research seed's conversation and `{research.<state>}` one of its researches (`npm run research:seed`). */
  readonly path: string;
  readonly signedIn: boolean;
  /** Signed in as a verified contributor instead of the demo account: the Improve form's screens. */
  readonly contributor?: boolean;
  /** Signed in as a curator of every part: the curator queue's screen. */
  readonly curator?: boolean;
  /** The page is a draft's (the suggest form's edit page): made through the API the first time a screen needs it, and deleted after the last viewport. */
  readonly draft?: DraftSpec;
  /** The dock does not render under 768px (feature-specs/20 was skipped): its states are a desktop's. */
  readonly desktopOnly?: boolean;
  /** Bring the page to the state to measure: open a picker, choose a mode. */
  readonly prepare?: (page: Page) => Promise<void>;
}

/** How long a prepare waits for its state: past it the screen is recorded as not rendered, and the run goes on. */
const PREPARE_MS = 15_000;

/** The research seed's report (feature-specs/43 § 13.11, 48 § 26; `npm run research:seed`), or why there is none. */
function researchSeedReport(): { readonly conversationId?: string | null; readonly research?: Readonly<Record<string, string>> } {
  const path = join("pipeline", "reports", "research-seed.json");
  if (!existsSync(path)) throw new Error("no research seed on this machine: run npm run research:seed");
  return JSON.parse(readFileSync(path, "utf8")) as { conversationId?: string | null; research?: Record<string, string> };
}

/** The research seed's Assistant conversation, whose turns carry the legacy research lines, and since unit 75 each answer's `Start a research` (48 § 9.1, § 9.3). */
function researchSeedConversation(): string {
  const id = researchSeedReport().conversationId;
  if (typeof id !== "string") throw new Error("the research seed has no Assistant conversation on this machine: run npm run research:seed without --page");
  return id;
}

/** One of the research seed's researches, or its answer to seed from (48 § 26; unit 72). */
function researchSeedState(state: string): string {
  const id = researchSeedReport().research?.[state];
  if (id === undefined) throw new Error("the research seed predates the Research page's states: run npm run research:seed");
  return id;
}

/** Every run's steps open, so their rows are measured too (48 § 11.3). */
async function stepsOpen(page: Page): Promise<void> {
  const toggles = page.locator('.run-steps-toggle[aria-expanded="false"]');
  await page.locator(".run-steps-toggle").first().waitFor({ timeout: PREPARE_MS });
  for (let left = await toggles.count(); left > 0; left = await toggles.count()) await toggles.first().click();
}

/** The legacy research line under each of the seed's turns, beside each answer's `Start a research`, and the proposal's consent open (43 § 5.1; 48 § 9.3). */
async function proposalConsent(page: Page): Promise<void> {
  const panel = page.locator("[data-proposal]").last();
  await panel.waitFor({ timeout: PREPARE_MS });
  await panel.scrollIntoViewIfNeeded();
  await panel.locator(".proposal-actions button").first().click({ timeout: PREPARE_MS });
  await panel.locator(".proposal-consent input[type=checkbox]").waitFor({ timeout: PREPARE_MS });
}

/** A draft of the contributor's for the edit page's screens: its anchor and its kind of change, which is final. */
interface DraftSpec {
  readonly anchor: { readonly kind: "SECTION" | "FIGURE" | "SOURCE_ROW"; readonly id: string };
  readonly changeKind: "SET_VALUE" | "EDIT_TEXT" | "EDIT_ROW" | "ADD_CLAIM" | "ADD_ROW";
}

/* One draft a kind, each one of the account's twenty a day: five a run. */
const VALUE: DraftSpec = { anchor: { kind: "FIGURE", id: "F-21-16" }, changeKind: "SET_VALUE" };
const PASSAGE: DraftSpec = { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT" };
const CLAIM: DraftSpec = { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM" };
const ROW: DraftSpec = { anchor: { kind: "SOURCE_ROW", id: "21.9 r10" }, changeKind: "EDIT_ROW" };
const NEW_ROW: DraftSpec = { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_ROW" };

/** Select in a source area the first run of words found once in it, and use it: the passage and its checks show. */
const pick = (area: string, checks: string) => async (page: Page) => {
  await page.evaluate((selector) => {
    const element = document.querySelector<HTMLTextAreaElement>(selector);
    if (element === null) throw new Error(`no ${selector}`);
    const passage = (element.value.match(/[A-Za-z][A-Za-z ,]{34,}/g) ?? []).map((run) => run.slice(0, 32).trim()).find((run) => element.value.split(run).length === 2);
    if (passage === undefined) throw new Error("no passage of the source is found once");
    const at = element.value.indexOf(passage);
    element.focus();
    element.setSelectionRange(at, at + passage.length);
  }, area);
  await page.locator(".source-pick-use button").click();
  await page.locator(checks).waitFor({ timeout: PREPARE_MS });
};

/** A claim placed after a passage: the place's choice, the source and the passage with its check. */
const claimAfter = async (page: Page) => {
  await page.locator(".edit-choice input[value=after]").check();
  await pick("#claim-source", "#claim-passage-check")(page);
};

/** A row's link refused: the field's error under it. */
const rowRefused = async (page: Page) => {
  await page.locator("#row-url").fill("not a link");
  await page.locator("#row-doi").focus();
  await page.locator("#row-url-problem").waitFor({ timeout: PREPARE_MS });
};

/** A new row of a new tier: the tier's name field, and the class moved by rule 4 with its line. */
const newTier = async (page: Page) => {
  await page.locator("#new-row-claim").fill("batch discount, provider tier 3");
  await page.locator("#new-row-citation").fill("Provider three pricing page");
  await page.locator("#new-row-tier").selectOption("NEW");
  await page.locator("#new-row-newTier").fill("regulator filing");
  await page.locator("#new-row-claim").focus();
  await page.locator(".class-panel-moved").filter({ hasText: /\S/ }).waitFor({ timeout: PREPARE_MS });
};

/**
 * Step 3 at its fullest (feature-specs/34 § 5; unit 51d): two graded items with their arithmetic, the corroboration row,
 * a grading and a wait at the budget cap, a graded upload and one graded U by rule, from reads the page answers itself
 * on the real one; and the upload's form open. A link that cannot be opened starts the reads; nothing reaches a model.
 */
const evidenceStates = async (page: Page) => {
  const draft = new URL(page.url()).pathname.split("/")[3] ?? "";
  await page.route(`**/api/v1/suggestions/${draft}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const json = (await response.json()) as { evidence: Array<Record<string, unknown>> };
    const real = json.evidence[0] ?? {};
    const item = (fields: Record<string, unknown>) => ({ ...real, kind: "LINK", doi: null, labRunId: null, publishedOn: null, gradedAt: null, ...fields });
    const graded = { state: "GRADED", relevance: 1, gradedBy: "suite-model", stage: null, fetchStatus: "opened:200" };
    const pending = { state: "PENDING", tier: null, baseScore: null, relevance: null, recency: null, independence: null, adjustedScore: null, gradedBy: null, ageDays: null, fetchStatus: "opened:200", stage: "3 of 3" };
    await route.fulfill({
      response,
      json: {
        ...json,
        evidence: [
          item({ ...graded, id: "11111111-1111-4111-8111-111111111111", ordinal: 1, url: "https://provider-two.example/pricing#cached-input", title: "Provider tier 2 pricing page · cached input", host: "provider-two.example", ageDays: 12, tier: "C", baseScore: 70, recency: 1, independence: 0.8, adjustedScore: 56, reason: "the vendor's page" }),
          item({ ...graded, id: "22222222-2222-4222-8222-222222222222", ordinal: 2, url: "https://price-tracker.example/providers/tier-2", title: "Independent price tracker · tier 2 schedule, 21 Apr 2026", host: "price-tracker.example", ageDays: 150, tier: "D", baseScore: 60, recency: 0.7, independence: 1, adjustedScore: 42, reason: "a tracker" }),
          item({ ...pending, id: "33333333-3333-4333-8333-333333333333", ordinal: 3, url: "https://bench.example/cost/2026-09", title: "Independent benchmark · cost per task, Sep 2026", host: "bench.example", reason: null }),
          item({ ...pending, id: "44444444-4444-4444-8444-444444444444", ordinal: 4, kind: "DOI", url: null, doi: "10.1000/182", title: null, host: null, reason: "budget cap; resets 2026-11-01" }),
          item({ ...graded, id: "55555555-5555-4555-8555-555555555555", ordinal: 5, kind: "UPLOAD", url: null, title: null, host: null, ageDays: 12, tier: "C", baseScore: 70, recency: 1, independence: 0.8, adjustedScore: 56, reason: "a screenshot of the vendor's page" }),
          item({ ...graded, id: "66666666-6666-4666-8666-666666666666", ordinal: 6, kind: "UPLOAD", url: null, title: null, host: null, ageDays: null, tier: "U", baseScore: 0, relevance: null, recency: null, independence: null, adjustedScore: 0, reason: "image_dimensions", gradedBy: "intake-rules" }),
        ],
        scoring: { score: 66, strongestItemId: "11111111-1111-4111-8111-111111111111", corroboratedById: "22222222-2222-4222-8222-222222222222", gradedItems: 2, pendingItems: 2, prediction: { route: "ADJUDICATE", decision: "REQUEST_MORE", namedTier: "D", acceptAt: 40, floorAt: 5, shortBy: null }, wouldSuffice: [] },
      },
    });
  });
  await page.locator(".evidence-add-row button").first().click();
  await page.locator("#evidence-add-value").fill("https://evidence-layout.invalid/report");
  await page.locator(".evidence-add-form button[type=submit]").click();
  await page.locator(".evidence-corroboration").waitFor({ timeout: PREPARE_MS });
  /* `+ Upload`'s form open under the row, its picker worded in PT (part 2). */
  await page.locator(".evidence-add-row button").nth(2).click();
  await page.locator(".evidence-file").waitFor({ timeout: PREPARE_MS });
};

/** The edit page's class panel at its longest: a unit about operating equipment moves the class, and the panel says why (feature-specs/34 § 5). */
const classMoved = async (page: Page) => {
  await page.locator("#value-after").fill("8000");
  await page.locator("#value-unit").fill("tokens, then reset the PLC");
  await page.locator("#value-after").focus();
  await page.locator(".class-panel-moved").filter({ hasText: /\S/ }).waitFor({ timeout: PREPARE_MS });
};

/** `Delete draft`'s dialog open over the edit page (feature-specs/45 § 4; unit 63g): opened from the rail, never confirmed, since the draft serves the other screens. */
const deleteDraftOpen = async (page: Page) => {
  await page.locator(".score-column [aria-haspopup=dialog]").click();
  await page.locator(".dialog-box").waitFor({ timeout: PREPARE_MS });
};

/** `Delete conversation`'s dialog open over the research seed's conversation (feature-specs/45 § 3.9; unit 62i): its longest title and body, a cited chapter and a proposal, never confirmed. */
const deleteConversationOpen = async (page: Page) => {
  await page.locator(".assistant-conversations .log-foot [aria-haspopup=dialog]").click();
  await page.locator(".dialog-box").waitFor({ timeout: PREPARE_MS });
};

/** A dialog of the Research page open (feature-specs/48 § 11.7, § 11.8; unit 73), opened by the control a selector finds and never confirmed. */
const researchDialog = (trigger: string) => async (page: Page) => {
  await page.locator(trigger).first().click({ timeout: PREPARE_MS });
  await page.locator(".dialog-box").waitFor({ timeout: PREPARE_MS });
};

/** The dock's mode strip is a radio group; the modes are in the strip's order (feature-specs/16 § 5.3). */
const mode = (index: number) => async (page: Page) => {
  await page.locator(".dock-mode-row [role=radio]").nth(index).click();
};

const SCREENS: ReadonlyArray<Screen> = [
  { id: "home", path: "/pt", signedIn: false },
  { id: "reader", path: "/pt/ch/21/21.3", signedIn: false },
  { id: "search", path: "/pt/search?q=cache", signedIn: false },
  { id: "search-empty", path: "/pt/search", signedIn: false },
  { id: "paths", path: "/pt/paths", signedIn: false },
  { id: "path", path: "/pt/paths/builder", signedIn: false },
  { id: "login", path: "/pt/login", signedIn: false },
  { id: "rubric", path: "/pt/rubric", signedIn: false },
  { id: "improve-home", path: "/pt/improve", signedIn: false },
  /* the research log (43 § 7.2; unit 60d), a curator's */
  { id: "research-log", path: "/pt/improve/research", signedIn: true, curator: true },
  /* the demo reader's own research proposals (43 § 6; unit 60c): the research seed's, where it has been run */
  { id: "improve-home-proposals", path: "/pt/improve", signedIn: true, prepare: async (page) => void (await page.locator("[data-proposal-row]").first().waitFor({ timeout: PREPARE_MS })) },
  { id: "improve-home-own", path: "/pt/improve", signedIn: true, contributor: true, draft: PASSAGE },
  /* Improve's two starts (48 § 10; unit 76): the demo reader's `From a research`, the research seed's done research's
     unused findings with their buttons; the chooser's chapters and a chapter's sections, a contributor's; its role notice, the demo reader's */
  { id: "improve-home-from-research", path: "/pt/improve", signedIn: true, prepare: async (page) => void (await page.locator("#from-research [data-finding-row]").first().waitFor({ timeout: PREPARE_MS })) },
  { id: "improve-new", path: "/pt/improve/new", signedIn: true, contributor: true },
  { id: "improve-new-chapter", path: "/pt/improve/new?ch=21", signedIn: true, contributor: true },
  { id: "improve-new-role", path: "/pt/improve/new", signedIn: true },
  { id: "curator-queue", path: "/pt/improve/queue", signedIn: true, curator: true },
  { id: "chapter-history", path: "/pt/ch/21/history", signedIn: false },
  { id: "chapter-history-signed-in", path: "/pt/ch/21/history", signedIn: true },
  { id: "home-signed-in", path: "/pt", signedIn: true },
  { id: "reader-signed-in", path: "/pt/ch/21/21.3", signedIn: true },
  { id: "marks", path: "/pt/marks", signedIn: true },
  { id: "account", path: "/pt/account", signedIn: true },
  /* Book management (47 § 3; unit 67), a curator's, and the account page as a curator, whose head carries its button */
  { id: "account-book", path: "/pt/account/book", signedIn: true, curator: true },
  { id: "account-curator", path: "/pt/account", signedIn: true, curator: true },
  { id: "assistant", path: "/pt/assistant", signedIn: true },
  { id: "assistant-statistics", path: "/pt/assistant?w=all&view=stats", signedIn: true },
  { id: "assistant-conversations", path: "/pt/assistant?view=conversations", signedIn: true },
  { id: "assistant-research", path: "/pt/assistant/{researchSeed}", signedIn: true, desktopOnly: false, prepare: proposalConsent },
  /* an answer since unit 75 (48 § 9.1, § 9.2): `Iniciar uma pesquisa` in its action row, no research line, and a refusal after it with neither */
  { id: "assistant-start-research", path: "/pt/assistant?ask={research.seedConversation}", signedIn: true, desktopOnly: false, prepare: async (page) => void (await page.locator(".turn-actions a").first().waitFor({ timeout: PREPARE_MS })) },
  /* Delete conversation (45 § 3.9; unit 62i): its dialog from the column, and the column's line after a delete */
  { id: "assistant-delete", path: "/pt/assistant?ask={researchSeed}&view=conversations", signedIn: true, prepare: deleteConversationOpen },
  { id: "assistant-deleted", path: "/pt/assistant?deleted=00000000-0000-4000-8000-0000000062e1&view=conversations", signedIn: true },
  /* the Research page (48 § 11; unit 72): its states, from the research seed's researches of the demo reader */
  { id: "research", path: "/pt/research", signedIn: true },
  { id: "research-seeded", path: "/pt/research?from={research.seedAnswer}", signedIn: true },
  { id: "research-from-invalid", path: "/pt/research?from=00000000-0000-4000-8000-0000000072e1", signedIn: true },
  { id: "research-done", path: "/pt/research?research={research.done}", signedIn: true, prepare: stepsOpen },
  { id: "research-under-way", path: "/pt/research?research={research.underWay}", signedIn: true },
  { id: "research-refused", path: "/pt/research?research={research.refused}", signedIn: true },
  { id: "research-stopped", path: "/pt/research?research={research.stopped}", signedIn: true, prepare: stepsOpen },
  { id: "research-purged", path: "/pt/research?research={research.purged}", signedIn: true },
  { id: "research-seeded-open", path: "/pt/research?research={research.seeded}", signedIn: true },
  { id: "research-conversations", path: "/pt/research?research={research.stopped}&view=conversations", signedIn: true },
  { id: "research-statistics", path: "/pt/research?view=stats", signedIn: true },
  /* its statistics over all time, the flags' and the delete's dialogs, and the list after a delete (48 § 11.6 to § 11.8; unit 73) */
  { id: "research-statistics-all", path: "/pt/research?w=all&view=stats", signedIn: true },
  { id: "research-flag", path: "/pt/research?research={research.done}", signedIn: true, prepare: researchDialog("article.run .run-actions button:not(.flag-flagged):not(:first-child)") },
  { id: "research-flag-refusal", path: "/pt/research?research={research.refused}", signedIn: true, prepare: researchDialog(".refusal-foot button") },
  { id: "research-delete", path: "/pt/research?research={research.done}&view=conversations", signedIn: true, prepare: researchDialog(".assistant-conversations .log-foot [aria-haspopup=dialog]") },
  { id: "research-deleted", path: "/pt/research?deleted=00000000-0000-4000-8000-0000000073e1&view=conversations", signedIn: true },
  /* a finding's send confirm (48 § 8.3; unit 74), the demo reader's button, opened and never confirmed */
  { id: "research-send", path: "/pt/research?research={research.done}", signedIn: true, prepare: researchDialog("section.finding .finding-action .finding-press button") },
  /* the Research dock (48 § 12; unit 77): the done research over a reader section, its steps open; the empty dock over a
     page, which under 768px is the phone notice with the Research page and the close */
  { id: "research-dock", path: "/pt/ch/21/21.3?research={research.done}", signedIn: true, desktopOnly: true, prepare: stepsOpen },
  { id: "research-dock-empty", path: "/pt/marks?research=1", signedIn: true },
  { id: "dock-explain", path: "/pt/ch/21/21.3?ask=1", signedIn: true, desktopOnly: true },
  { id: "dock-compare", path: "/pt/ch/21/21.3?ask=1", signedIn: true, desktopOnly: true, prepare: mode(1) },
  { id: "dock-walk", path: "/pt/ch/21/21.3?ask=1", signedIn: true, desktopOnly: true, prepare: mode(2) },
  { id: "dock-lab", path: "/pt/ch/21/21.3?ask=1", signedIn: true, desktopOnly: true, prepare: mode(3) },
  { id: "dock-brief", path: "/pt/ch/21/21.3?ask=1", signedIn: true, desktopOnly: true, prepare: mode(4) },
  { id: "dock-over-page", path: "/pt/marks?ask=1", signedIn: true, desktopOnly: true },
  { id: "suggest-start", path: "/pt/ch/21/improve/new?anchor=21.3", signedIn: true, contributor: true },
  { id: "suggest-start-figure", path: "/pt/ch/21/improve/new?anchor=F-21-05&from=21.3", signedIn: true, contributor: true },
  { id: "suggest-start-row", path: "/pt/ch/21/improve/new?anchor=21.9+r10&from=21.3", signedIn: true, contributor: true },
  { id: "suggest-start-missing", path: "/pt/ch/21/improve/new?anchor=21.9+r999", signedIn: true, contributor: true },
  { id: "suggest-start-role", path: "/pt/ch/21/improve/new?anchor=21.3", signedIn: true },
  { id: "suggest-edit", path: "/pt/improve/{draft}/edit", signedIn: true, contributor: true, draft: VALUE },
  /* Under 768px the edit page is the "desktop or tablet" notice (34 § 16): its panel and editors are a desktop's. */
  { id: "suggest-edit-class-moved", path: "/pt/improve/{draft}/edit", signedIn: true, contributor: true, draft: VALUE, desktopOnly: true, prepare: classMoved },
  { id: "suggest-edit-passage", path: "/pt/improve/{draft}/edit", signedIn: true, contributor: true, draft: PASSAGE, desktopOnly: true, prepare: pick("#text-source", "#text-before-check") },
  { id: "suggest-edit-evidence", path: "/pt/improve/{draft}/edit", signedIn: true, contributor: true, draft: PASSAGE, desktopOnly: true, prepare: evidenceStates },
  { id: "suggest-edit-claim", path: "/pt/improve/{draft}/edit", signedIn: true, contributor: true, draft: CLAIM, desktopOnly: true, prepare: claimAfter },
  { id: "suggest-edit-row", path: "/pt/improve/{draft}/edit", signedIn: true, contributor: true, draft: ROW, desktopOnly: true, prepare: rowRefused },
  { id: "suggest-edit-new-row", path: "/pt/improve/{draft}/edit", signedIn: true, contributor: true, draft: NEW_ROW, desktopOnly: true, prepare: newTier },
  /* Delete draft (45 § 4; unit 63g): its dialog on the rail, and the Improve page's Done notice after it */
  { id: "suggest-edit-delete", path: "/pt/improve/{draft}/edit", signedIn: true, contributor: true, draft: VALUE, desktopOnly: true, prepare: deleteDraftOpen },
  { id: "improve-home-deleted", path: "/pt/improve?deleted=S-15-0377", signedIn: true, contributor: true, draft: PASSAGE },
];

/** Who a screen is measured as: signed out, the demo account, a verified contributor, or a curator. */
type Who = "out" | "demo" | "contributor" | "curator";
const whoOf = (screen: Screen): Who => (!screen.signedIn ? "out" : screen.contributor === true ? "contributor" : screen.curator === true ? "curator" : "demo");

const FIXTURE = padCatalogue(en as Messages, pt as Messages);
/** A label of the fixture that the home page's markup always carries: proof that the server serves the padded catalogue. */
const SENTINEL = ((FIXTURE.chrome as Messages).nav as Messages).book as string;

/** A draft of the contributor's, made as step 1's button makes it, for the edit page's screens: one of the account's twenty a day. */
async function draftFor(context: BrowserContext, origin: string, spec: DraftSpec): Promise<string> {
  const response = await context.request.post("/api/v1/suggestions", { headers: { origin, "idempotency-key": randomUUID() }, data: { anchor: spec.anchor, changeKind: spec.changeKind, locale: "pt" } });
  if (!response.ok()) throw new Error(`the draft was not created: the API answered ${String(response.status())}`);
  return ((await response.json()) as { id: string }).id;
}

async function contextFor(browser: Browser, viewport: (typeof VIEWPORTS)[number], who: Who): Promise<BrowserContext | string> {
  const context = await browser.newContext({ viewport, extraHTTPHeaders: { [FIXTURE_HEADER]: PADDED_FIXTURE } });
  /* Without the fixture the suite would pass by measuring the strings as they ship: that is not this test. Asked of
     the markup, not of the screen, because a phone's top bar does not show the label. */
  if (!(await (await context.request.get("/pt")).text()).includes(SENTINEL)) {
    await context.close();
    return "the server did not serve the padded catalogue: it is a development server's facility, refused in production";
  }
  if (who === "out") return context;
  const page = await context.newPage();
  const account = who === "contributor" ? `${encodeURIComponent(CONTRIBUTOR)}&role=CONTRIBUTOR&verified=true` : who === "curator" ? `${encodeURIComponent(CURATOR)}&role=CURATOR&verified=true` : encodeURIComponent(DEMO);
  const response = await page.goto(`/api/v1/auth/dev?email=${account}&next=${encodeURIComponent("/pt")}`);
  const signed = (await context.cookies()).length > 0 && response !== null && response.status() < 400;
  await page.close();
  if (signed) return context;
  await context.close();
  return `the dev sign-in answered ${String(response?.status() ?? "nothing")}: the signed-in screens need a development server (AUTH_DEV_PROVIDER=1)`;
}

test("PT labels wrap and never truncate, every string 30 % longer than its EN counterpart", async ({ browser, baseURL, request }) => {
  const release = ((await (await request.get("/api/v1/releases/current")).json()) as { id?: string }).id ?? "unknown";
  const fixture = fixtureStats(en as Messages, pt as Messages, FIXTURE);
  const screens: LayoutScreen[] = [];
  const skipped: Array<{ id: string; viewport: number; reason: string }> = [];
  const origin = new URL(baseURL ?? "").origin;
  /* The drafts are the account's, whichever context made them: one a kind for every viewport, deleted at the end. */
  const drafts = new Map<DraftSpec, string>();

  try {
    for (const viewport of VIEWPORTS) {
      /* the curator's screens too (43 § 13.11): the loop once skipped them without a word */
      for (const who of ["out", "demo", "contributor", "curator"] as const) {
        const wanted = SCREENS.filter((screen) => whoOf(screen) === who && !(screen.desktopOnly === true && viewport.width < 768));
        if (wanted.length === 0) continue;
        const context = await contextFor(browser, viewport, who);
        if (typeof context === "string") {
          for (const screen of wanted) skipped.push({ id: screen.id, viewport: viewport.width, reason: context });
          continue;
        }
        const page = await context.newPage();
        for (const screen of wanted) {
          try {
            let draft = screen.draft === undefined ? undefined : drafts.get(screen.draft);
            if (screen.draft !== undefined && draft === undefined) {
              draft = await draftFor(context, origin, screen.draft);
              drafts.set(screen.draft, draft);
            }
            const path = screen.path
              .replace("{draft}", draft ?? "")
              .replace("{researchSeed}", () => researchSeedConversation())
              .replace(/\{research\.(\w+)\}/g, (_, state: string) => researchSeedState(state));
            const response = await page.goto(path, { waitUntil: "networkidle" });
            if (response === null || response.status() >= 400) throw new Error(`the page answered ${String(response?.status() ?? "nothing")}`);
            await page.evaluate(() => document.fonts.ready);
            if (screen.prepare !== undefined) await screen.prepare(page);
            const measured = await page.evaluate(measureLayout);
            screens.push({ id: screen.id, path: screen.path, viewport: viewport.width, labels: measured.labels, findings: [...measured.findings] });
            console.log(`${String(viewport.width).padStart(4)} ${screen.id.padEnd(24)} ${String(measured.labels).padStart(4)} labels · ${measured.findings.length === 0 ? "ok" : `${String(measured.findings.length)} truncated`}`);
          } catch (error: unknown) {
            skipped.push({ id: screen.id, viewport: viewport.width, reason: error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error) });
            console.log(`${String(viewport.width).padStart(4)} ${screen.id.padEnd(24)} not rendered`);
          }
        }
        await context.close();
      }
    }
  } finally {
    /* The drafts go whatever the screens did: a run that ends early must not spend the account's next runs. */
    if (drafts.size > 0) {
      const owner = await contextFor(browser, VIEWPORTS[0], "contributor");
      if (typeof owner !== "string") {
        for (const draft of drafts.values()) await owner.request.delete(`/api/v1/suggestions/${draft}`, { headers: { origin } });
        await owner.close();
      }
    }
  }

  const report: TruncationReport = { release, ranAt: new Date().toISOString(), baseUrl: baseURL ?? "", fixture: { ...fixture, short: [...fixture.short] }, screens, skipped };
  mkdirSync(join("pipeline", "reports"), { recursive: true });
  const file = join("pipeline", "reports", truncationReportName(release));
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report written to ${file}`);

  /* The fixture first: the suite means nothing if a string in it is not 30 % longer than its EN counterpart. */
  expect(fixture.short, "fixture strings short of 30 % longer than EN").toEqual([]);
  expect(skipped.map((entry) => `${String(entry.viewport)} ${entry.id}: ${entry.reason}`), "screens that were not rendered").toEqual([]);
  const truncated = screens.flatMap((screen) => screen.findings.map((finding) => `${String(screen.viewport)} ${screen.id}: ${finding.kind} by ${String(finding.by)}px · ${finding.element} · ${finding.text}`));
  expect(truncated, "truncated labels").toEqual([]);
});
