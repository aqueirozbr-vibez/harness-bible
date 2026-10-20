import { describe, expect, it } from "vitest";

import type { ResearchFindingView, ResearchRunView } from "@/lib/schemas/api";

import { findingActionOf, findingRoleOf, refusalOfAnswer, sendSettled, type FindingLocal, type FindingRole } from "./findingAction";

/*
 * A finding's button by role and its lines (feature-specs/48 § 8.1, § 18; unit 74): one button, the role's; the throttle
 * notice in its place for a throttled contributor; a used finding's outcome line; each code a send left, with the button
 * again only where trying again can help; the client's own `sending` after a 202 and `reload to follow` after a minute;
 * and what each refusal of a press says.
 */

const finding = (use: Partial<ResearchFindingView["use"]> = {}, textPurged = false): Pick<ResearchFindingView, "use" | "textPurged" | "anchor"> => ({
  use: { state: "VALID", suggestionId: null, href: null, failure: null, ...use },
  textPurged,
  anchor: textPurged ? null : { kind: "SECTION", id: "21.3", section: "21.3", title: "Worked numbers" },
});
const DRAFT: FindingRole = { kind: "draft" };
const RESET = "2026-11-01T00:00:00.000Z";
const SEND: FindingRole = { kind: "send", configured: true, sendsResetAt: RESET };
const UNCONFIGURED: FindingRole = { kind: "send", configured: false, sendsResetAt: RESET };
const IDLE: FindingLocal = { kind: "idle" };

describe("findingActionOf: the button of the role (48 § 8.1)", () => {
  it("offers a verified contributor the draft, anyone else the send, and a throttled contributor the notice and no button", () => {
    expect(findingActionOf(finding(), DRAFT, IDLE)).toEqual({ line: null, button: { action: "draft", disabled: false }, throttled: null, open: null, proposal: false });
    expect(findingActionOf(finding(), SEND, IDLE)).toEqual({ line: null, button: { action: "send", disabled: false }, throttled: null, open: null, proposal: false });
    expect(findingActionOf(finding(), { kind: "throttled", until: "2026-11-01T00:00:00.000Z" }, IDLE)).toEqual({ line: null, button: null, throttled: "2026-11-01T00:00:00.000Z", open: null, proposal: false });
  });

  it("disables the send with the unconfigured line where research proposals are not configured here, and any button while a press is out", () => {
    expect(findingActionOf(finding(), UNCONFIGURED, IDLE)).toMatchObject({ line: { key: "unconfigured" }, button: { action: "send", disabled: true } });
    expect(findingActionOf(finding(), DRAFT, { kind: "pressed" }).button).toEqual({ action: "draft", disabled: true });
  });

  it("reads a used finding as its outcome's line, a draft with Open draft, a proposal with its panel, whatever was pressed", () => {
    expect(findingActionOf(finding({ state: "DRAFTED", suggestionId: "S-21-0042", href: "/improve/S-21-0042/edit" }), DRAFT, IDLE)).toEqual({ line: { key: "drafted", values: { id: "S-21-0042" } }, button: null, throttled: null, open: "/improve/S-21-0042/edit", proposal: false });
    expect(findingActionOf(finding({ state: "SENT" }), SEND, { kind: "sending" })).toMatchObject({ line: { key: "sent" }, button: null });
    expect(findingActionOf(finding({ state: "PROPOSED", suggestionId: "S-21-0042" }), SEND, IDLE)).toMatchObject({ line: { key: "proposed" }, proposal: true });
    expect(findingActionOf(finding({ state: "REFUTED" }), SEND, IDLE).line).toEqual({ key: "refuted", values: {} });
    expect(findingActionOf(finding({ state: "DUPLICATE" }), SEND, IDLE).line).toEqual({ key: "duplicateHidden", values: {} });
    expect(findingActionOf(finding({ state: "DUPLICATE", suggestionId: "S-21-0007" }), SEND, IDLE).line).toEqual({ key: "duplicate", values: { id: "S-21-0007" } });
  });

  it("says an unused finding's text was removed, with no button", () => {
    expect(findingActionOf(finding({}, true), DRAFT, IDLE)).toEqual({ line: { key: "purged", values: {} }, button: null, throttled: null, open: null, proposal: false });
  });

  it("turns each code a send left into its line, the button again for the principal and the rubric, none for the anchor gone, a finding that does not read or its text gone", () => {
    expect(findingActionOf(finding({ failure: "RESEARCH_UNCONFIGURED" }), SEND, IDLE)).toMatchObject({ line: { key: "unconfigured" }, button: { action: "send", disabled: false } });
    expect(findingActionOf(finding({ failure: "RESEARCH_UNCONFIGURED" }), UNCONFIGURED, IDLE)).toMatchObject({ line: { key: "unconfigured" }, button: { disabled: true } });
    expect(findingActionOf(finding({ failure: "NO_RUBRIC" }), SEND, IDLE)).toMatchObject({ line: { key: "noRubric" }, button: { action: "send" } });
    expect(findingActionOf(finding({ failure: "ANCHOR_UNKNOWN" }), SEND, IDLE)).toMatchObject({ line: { key: "anchorGone", values: { anchor: "21.3" } }, button: null });
    expect(findingActionOf(finding({ failure: "PARSE" }), SEND, IDLE)).toMatchObject({ line: { key: "unreadable" }, button: null });
    expect(findingActionOf(finding({ failure: "TEXT_PURGED" }), SEND, IDLE)).toMatchObject({ line: { key: "purged" }, button: null });
  });

  it("reads a send that met the month's thirty in its transaction as the month's limit with the reset the page read, and offers the send again — to someone who drafts now, nothing (D5; review of unit 74)", () => {
    expect(findingActionOf(finding({ failure: "SENDS_LIMIT" }), SEND, IDLE)).toEqual({ line: { key: "sendsLimit", values: { resetsAt: RESET } }, button: { action: "send", disabled: false }, throttled: null, open: null, proposal: false });
    expect(findingActionOf(finding({ failure: "SENDS_LIMIT" }), UNCONFIGURED, IDLE)).toMatchObject({ line: { key: "sendsLimit" }, button: { action: "send", disabled: true } });
    expect(findingActionOf(finding({ failure: "SENDS_LIMIT" }), DRAFT, IDLE)).toEqual({ line: null, button: { action: "draft", disabled: false }, throttled: null, open: null, proposal: false });
    /* a press answered 429 at the limit: the answer's reset, and no button */
    expect(findingActionOf(finding({ failure: "SENDS_LIMIT" }), SEND, { kind: "refused", refusal: { kind: "sendsLimit", resetsAt: "2026-12-01T00:00:00.000Z" } })).toMatchObject({ line: { key: "sendsLimit", values: { resetsAt: "2026-12-01T00:00:00.000Z" } }, button: null });
  });

  it("reads `sending to Improve` after a 202 until the follow sees the finding move, and `reload to follow` after its minute", () => {
    expect(findingActionOf(finding(), SEND, { kind: "sending" })).toEqual({ line: { key: "sending", values: {} }, button: null, throttled: null, open: null, proposal: false });
    expect(findingActionOf(finding(), SEND, { kind: "lost" }).line).toEqual({ key: "followLost", values: {} });
    /* a failure the follow saw takes the place of `sending` */
    expect(findingActionOf(finding({ failure: "NO_RUBRIC" }), SEND, { kind: "idle" }).line?.key).toBe("noRubric");
  });

  it("shows what a refused press said: the engine down offers the button again, the rest do not; the throttle is its notice", () => {
    expect(findingActionOf(finding(), SEND, { kind: "refused", refusal: { kind: "unavailable" } })).toMatchObject({ line: { key: "unavailable" }, button: { action: "send", disabled: false } });
    expect(findingActionOf(finding(), SEND, { kind: "refused", refusal: { kind: "duplicate", suggestionId: null } })).toMatchObject({ line: { key: "duplicateHidden" }, button: null });
    expect(findingActionOf(finding(), SEND, { kind: "refused", refusal: { kind: "sendsLimit", resetsAt: "2026-11-01T00:00:00.000Z" } })).toMatchObject({ line: { key: "sendsLimit", values: { resetsAt: "2026-11-01T00:00:00.000Z" } }, button: null });
    expect(findingActionOf(finding(), DRAFT, { kind: "refused", refusal: { kind: "throttled", until: "2026-11-01T00:00:00.000Z" } })).toEqual({ line: null, button: null, throttled: "2026-11-01T00:00:00.000Z", open: null, proposal: false });
    expect(findingActionOf(finding(), DRAFT, { kind: "refused", refusal: { kind: "anchorGone" } }).line).toEqual({ key: "anchorGone", values: { anchor: "21.3" } });
    /* a send answered unconfigured: the button again, disabled, as the page would have drawn it (§ 8.1) */
    expect(findingActionOf(finding(), SEND, { kind: "refused", refusal: { kind: "unconfigured" } })).toMatchObject({ line: { key: "unconfigured" }, button: { action: "send", disabled: true } });
  });
});

describe("findingRoleOf: who drafts and who sends (48 § 8.1, A4)", () => {
  const NOW = new Date("2026-10-12T12:00:00.000Z");
  it("lets a verified contributor or curator draft, pauses a throttled one, and has everyone else send", () => {
    expect(findingRoleOf({ role: "CONTRIBUTOR", identityVerified: true }, null, true, NOW)).toEqual({ kind: "draft" });
    expect(findingRoleOf({ role: "CURATOR", identityVerified: true }, null, false, NOW)).toEqual({ kind: "draft" });
    expect(findingRoleOf({ role: "CONTRIBUTOR", identityVerified: true }, new Date("2026-11-01T00:00:00.000Z"), true, NOW)).toEqual({ kind: "throttled", until: "2026-11-01T00:00:00.000Z" });
    /* a pause that has ended is no pause */
    expect(findingRoleOf({ role: "CONTRIBUTOR", identityVerified: true }, new Date("2026-10-01T00:00:00.000Z"), true, NOW)).toEqual({ kind: "draft" });
    expect(findingRoleOf({ role: "CONTRIBUTOR", identityVerified: false }, null, true, NOW)).toEqual({ kind: "send", configured: true, sendsResetAt: RESET });
    for (const role of ["READER", "BUILDER", "ORG_ADMIN"] as const) expect(findingRoleOf({ role, identityVerified: true }, null, false, NOW)).toEqual({ kind: "send", configured: false, sendsResetAt: RESET });
    /* the month's reset in UTC: 21:30 on the 31st in São Paulo is November's, which resets on December's first */
    expect(findingRoleOf({ role: "READER", identityVerified: false }, null, true, new Date("2026-10-31T21:30:00.000-03:00"))).toEqual({ kind: "send", configured: true, sendsResetAt: "2026-12-01T00:00:00.000Z" });
  });
});

describe("refusalOfAnswer: what a refused press said (48 § 18)", () => {
  it("names each refusal by its code, reads a used finding again, and takes anything else for an engine that could not take it now", () => {
    expect(refusalOfAnswer(409, { code: "FINDING_USED", detail: { use: "SENT", suggestionId: null } })).toBe("reread");
    expect(refusalOfAnswer(404, { code: "NOT_FOUND" })).toBe("reread");
    expect(refusalOfAnswer(409, { code: "PROPOSAL_DUPLICATE", detail: { suggestionId: "S-21-0007" } })).toEqual({ kind: "duplicate", suggestionId: "S-21-0007" });
    expect(refusalOfAnswer(409, { code: "PROPOSAL_DUPLICATE", detail: { suggestionId: null } })).toEqual({ kind: "duplicate", suggestionId: null });
    expect(refusalOfAnswer(422, { code: "ANCHOR_UNKNOWN", detail: { anchor: "21.3" } })).toEqual({ kind: "anchorGone" });
    expect(refusalOfAnswer(409, { code: "FINDING_PURGED" })).toEqual({ kind: "purged" });
    expect(refusalOfAnswer(422, { code: "UNPROCESSABLE", detail: { failure: "PARSE" } })).toEqual({ kind: "unreadable" });
    expect(refusalOfAnswer(503, { code: "RESEARCH_UNAVAILABLE" })).toEqual({ kind: "unconfigured" });
    expect(refusalOfAnswer(429, { code: "RESEARCH_SENDS_LIMIT", detail: { resetsAt: "2026-11-01T00:00:00.000Z" } })).toEqual({ kind: "sendsLimit", resetsAt: "2026-11-01T00:00:00.000Z" });
    expect(refusalOfAnswer(429, { code: "SUGGESTION_THROTTLED", detail: { throttledUntil: "2026-11-01T00:00:00.000Z" } })).toEqual({ kind: "throttled", until: "2026-11-01T00:00:00.000Z" });
    expect(refusalOfAnswer(503, { code: "WORKFLOWS_UNAVAILABLE" })).toEqual({ kind: "unavailable" });
    expect(refusalOfAnswer(500, null)).toEqual({ kind: "unavailable" });
    /* the day's rate, not the month's sends */
    expect(refusalOfAnswer(429, { code: "RATE_LIMITED" })).toEqual({ kind: "unavailable" });
  });
});

describe("sendSettled: the follow's end (48 § 8.3, § 26)", () => {
  const view = (findings: ReadonlyArray<Pick<ResearchFindingView, "id" | "use">>): ResearchRunView => ({ findings } as unknown as ResearchRunView);
  const ID = "55555555-5555-4555-8555-555555555555";
  const use = (state: ResearchFindingView["use"]["state"], failure: string | null = null) => view([{ id: ID, use: { state, suggestionId: null, href: null, failure } }]);
  it("ends when the finding failed, was a duplicate, was placed by Improve, or is gone; one still VALID with no code, or sent and being checked, is followed on", () => {
    expect(sendSettled(use("VALID"), ID)).toBe(false);
    expect(sendSettled(use("SENT"), ID)).toBe(false);
    expect(sendSettled(use("PROPOSED"), ID)).toBe(true);
    expect(sendSettled(use("REFUTED"), ID)).toBe(true);
    expect(sendSettled(use("DUPLICATE"), ID)).toBe(true);
    expect(sendSettled(use("VALID", "NO_RUBRIC"), ID)).toBe(true);
    expect(sendSettled(view([]), ID)).toBe(true);
  });

  it("keeps a sent finding's line when the minute ends: `reload to follow` is for a finding the follow never saw move", () => {
    expect(findingActionOf(finding({ state: "SENT" }), SEND, { kind: "lost" }).line).toEqual({ key: "sent", values: {} });
    expect(findingActionOf(finding(), SEND, { kind: "lost" }).line).toEqual({ key: "followLost", values: {} });
  });
});
