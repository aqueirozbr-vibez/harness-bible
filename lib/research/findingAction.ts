import { suggestGate } from "@/lib/improve/suggest";
import type { ResearchFindingView, ResearchRunView } from "@/lib/schemas/api";
import type { Role } from "@/lib/schemas/auth";
import { FINDING_FAILURES, sendsMonthOf, type FindingFailure } from "@/lib/schemas/research";

import { findingUseLineOf, type FindingUseLine } from "./runBlock";

/*
 * A finding's button by role and its lines (feature-specs/48 § 8.1, § 18, § 20; unit 74), pure: what the block under a
 * finding shows, from the finding as the page last read it, the person's role as the draft door and the policy decide
 * it, and what they did here since the page loaded. The component (components/research/FindingAction.tsx) renders it.
 *
 *   - a verified contributor or curator (`suggestGate`'s form) gets `Draft it in Improve` with its help line;
 *   - one the throttle pauses gets the step 1 throttle notice in place of the button: the policy refuses them the send,
 *     since they draft, and the draft door refuses a throttled contributor (§ 8.1, § 22);
 *   - anyone else gets `Send to Improve`, disabled with the unconfigured line where research proposals are not
 *     configured here;
 *   - a finding used is its outcome's line, a draft's with `Open draft`, a proposal's with its panel; one whose run's
 *     text is gone and was never used, the purged sentence and no button;
 *   - a code an earlier send left, its line: the button again where trying again can help (the principal, the rubric,
 *     the month's thirty, which reset), none where the finding cannot be sent as it is (the anchor gone, a finding that
 *     no longer reads, its text gone);
 *   - after a send's 202, `sending to Improve` until the follow sees the finding move, then its line — `sent · being
 *     checked by Improve`, and `sent · proposed` or `not proposed` where Improve places it within the minute; a minute
 *     in which the finding never moved, `reload to follow`.
 */

/**
 * Who the person is to a finding (§ 8.1, A4): they draft, the throttle pauses them, or they send — the research
 * proposals configured here, or not, and when the month's thirty reset as the page was read (D5), the date a send that
 * ended `SENDS_LIMIT` names.
 */
export type FindingRole = { readonly kind: "draft" } | { readonly kind: "throttled"; readonly until: string } | { readonly kind: "send"; readonly configured: boolean; readonly sendsResetAt: string };

/**
 * Who the person is to their findings (48 § 8.1, A4), in the order the draft door refuses (`suggestGate`): a contributor
 * or curator with a verified identity drafts, unless the throttle pauses them; anyone else sends, and is told where
 * research proposals are not configured here.
 */
export function findingRoleOf(user: { readonly role: Role; readonly identityVerified: boolean }, throttledUntil: Date | null, configured: boolean, now: Date): FindingRole {
  const gate = suggestGate(user, throttledUntil, now);
  if (gate.kind === "form") return { kind: "draft" };
  if (gate.kind === "throttled") return { kind: "throttled", until: gate.until.toISOString() };
  return { kind: "send", configured, sendsResetAt: sendsMonthOf(now).resetsAt.toISOString() };
}

/** What an answer to a press said that the finding's row does not (§ 18): each a line the block shows until the page is read again. */
export type FindingRefusal =
  | { readonly kind: "duplicate"; readonly suggestionId: string | null }
  | { readonly kind: "anchorGone" }
  | { readonly kind: "purged" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "unconfigured" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "sendsLimit"; readonly resetsAt: string }
  | { readonly kind: "throttled"; readonly until: string };

/** What the person did to the finding here since the page loaded. */
export type FindingLocal = { readonly kind: "idle" } | { readonly kind: "pressed" } | { readonly kind: "sending" } | { readonly kind: "lost" } | { readonly kind: "refused"; readonly refusal: FindingRefusal };

/** A line of the block: a key of `research.findings` with its values; the anchor's id for the anchor gone, the date for the month's reset. */
export interface FindingLine {
  readonly key: FindingUseLine["key"] | "anchorGone" | "unconfigured" | "noRubric" | "unreadable" | "unavailable" | "sendsLimit" | "sending" | "followLost";
  readonly values: Readonly<Record<string, string>>;
}

/** What the block shows (§ 8.1). */
export interface FindingActionView {
  /** The status line, or none: an unused finding with nothing to say. */
  readonly line: FindingLine | null;
  /** The button of the person's role, or none; disabled while a press is out or proposals are not configured. */
  readonly button: { readonly action: "draft" | "send"; readonly disabled: boolean } | null;
  /** The step 1 throttle notice, until when, in place of the button. */
  readonly throttled: string | null;
  /** A draft's `Open draft`, the path under the page's locale. */
  readonly open: string | null;
  /** A proposed finding's panel follows the line. */
  readonly proposal: boolean;
}

/**
 * The line a send's code gives, and whether the button is offered again (§ 8.1's rows). `SENDS_LIMIT` reads the month's
 * limit with its reset as the page was read, and offers the button again: the code says nothing of the month it was
 * written in, a press after the reset goes through, and one before it is answered 429 with the reset. To someone who
 * drafts now, whose drafts the thirty do not count, it says nothing.
 */
function failureOf(failure: FindingFailure, anchor: string, role: FindingRole): { readonly line: FindingLine | null; readonly again: boolean } {
  switch (failure) {
    case "SENDS_LIMIT":
      return { line: role.kind === "send" ? { key: "sendsLimit", values: { resetsAt: role.sendsResetAt } } : null, again: true };
    case "RESEARCH_UNCONFIGURED":
      return { line: { key: "unconfigured", values: {} }, again: true };
    case "NO_RUBRIC":
      return { line: { key: "noRubric", values: {} }, again: true };
    case "ANCHOR_UNKNOWN":
      return { line: { key: "anchorGone", values: { anchor } }, again: false };
    case "PARSE":
      return { line: { key: "unreadable", values: {} }, again: false };
    case "TEXT_PURGED":
      return { line: { key: "purged", values: {} }, again: false };
    default: {
      const never: never = failure;
      return never;
    }
  }
}

/** A refusal's line, and whether the button is offered again: an engine that did not take it now, or proposals not configured here (disabled), and only those. */
function refusalOf(refusal: FindingRefusal, anchor: string): { readonly line: FindingLine | null; readonly again: boolean; readonly throttled: string | null } {
  switch (refusal.kind) {
    case "duplicate":
      return { line: refusal.suggestionId === null ? { key: "duplicateHidden", values: {} } : { key: "duplicate", values: { id: refusal.suggestionId } }, again: false, throttled: null };
    case "anchorGone":
      return { line: { key: "anchorGone", values: { anchor } }, again: false, throttled: null };
    case "purged":
      return { line: { key: "purged", values: {} }, again: false, throttled: null };
    case "unreadable":
      return { line: { key: "unreadable", values: {} }, again: false, throttled: null };
    case "unconfigured":
      return { line: { key: "unconfigured", values: {} }, again: true, throttled: null };
    case "unavailable":
      return { line: { key: "unavailable", values: {} }, again: true, throttled: null };
    case "sendsLimit":
      return { line: { key: "sendsLimit", values: { resetsAt: refusal.resetsAt } }, again: false, throttled: null };
    case "throttled":
      return { line: null, again: false, throttled: refusal.until };
    default: {
      const never: never = refusal;
      return never;
    }
  }
}

const KNOWN_FAILURES: ReadonlySet<string> = new Set<string>(FINDING_FAILURES);

export function findingActionOf(finding: Pick<ResearchFindingView, "use" | "textPurged" | "anchor">, role: FindingRole, local: FindingLocal): FindingActionView {
  const none: FindingActionView = { line: null, button: null, throttled: null, open: null, proposal: false };
  const anchor = finding.anchor?.id ?? "—";
  const { use } = finding;
  /* used: its outcome's line, whatever was pressed here */
  if (use.state !== "VALID") {
    const line = findingUseLineOf(finding);
    return { ...none, line, open: use.state === "DRAFTED" ? use.href : null, proposal: use.state === "PROPOSED" };
  }
  /* unused, its run's text gone: it can no longer be used, and says so */
  if (finding.textPurged) return { ...none, line: { key: "purged", values: {} } };
  if (local.kind === "sending") return { ...none, line: { key: "sending", values: {} } };
  if (local.kind === "lost") return { ...none, line: { key: "followLost", values: {} } };
  const button = (again: boolean): FindingActionView["button"] => {
    if (!again) return null;
    if (role.kind === "draft") return { action: "draft", disabled: local.kind === "pressed" };
    /* a send the web tier answered unconfigured (503 `RESEARCH_UNAVAILABLE`): the button again, disabled while it sees no research principal (§ 8.1) */
    if (role.kind === "send") return { action: "send", disabled: local.kind === "pressed" || !role.configured || (local.kind === "refused" && local.refusal.kind === "unconfigured") };
    return null;
  };
  const throttled = role.kind === "throttled" ? role.until : null;
  if (local.kind === "refused") {
    const refused = refusalOf(local.refusal, anchor);
    return { ...none, line: refused.line, button: refused.throttled === null ? button(refused.again) : null, throttled: refused.throttled ?? throttled };
  }
  if (use.failure !== null && KNOWN_FAILURES.has(use.failure)) {
    const failed = failureOf(use.failure as FindingFailure, anchor, role);
    return { ...none, line: failed.line, button: button(failed.again), throttled };
  }
  /* nothing done yet: the button of the role, the unconfigured line beside a send that cannot be made here */
  if (role.kind === "send" && !role.configured) return { ...none, line: { key: "unconfigured", values: {} }, button: button(true) };
  return { ...none, button: button(true), throttled };
}

/**
 * Whether a send's follow is over (§ 8.3, § 26): the finding failed with a code, was a duplicate, or Improve has placed
 * it — proposed or refuted — or it is gone from the run. A finding sent and still being checked is followed on within
 * the same minute, so a proposal Improve places quickly reads `sent · proposed` without a reload; one still being checked
 * when the minute ends keeps its `sent · being checked by Improve`, which is true, and only a finding the follow never saw
 * move reads `reload to follow`.
 */
export function sendSettled(view: ResearchRunView, findingId: string): boolean {
  const finding = view.findings.find((candidate) => candidate.id === findingId);
  if (finding === undefined) return true;
  const { state, failure } = finding.use;
  return state === "VALID" ? failure !== null : state !== "SENT";
}

/** How long a send is followed (§ 8.3): a minute, after which a finding the follow never saw move reads `reload to follow`. */
export const SEND_FOLLOW_MS = 60_000;

/**
 * What an answer that was not a 2xx said (§ 18), by its code: the refusal the block shows, or `reread` for a finding
 * used meanwhile, whose use is read again from the run's view. Anything else — a 5xx, the engine down, the network —
 * is `unavailable`, and the button is offered again.
 */
export function refusalOfAnswer(status: number, body: { readonly code?: unknown; readonly detail?: unknown } | null): FindingRefusal | "reread" {
  const code = typeof body?.code === "string" ? body.code : null;
  const detail = typeof body?.detail === "object" && body.detail !== null ? (body.detail as Record<string, unknown>) : {};
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  if (code === "FINDING_USED" || status === 404) return "reread";
  if (code === "PROPOSAL_DUPLICATE") return { kind: "duplicate", suggestionId: text(detail.suggestionId) };
  if (code === "ANCHOR_UNKNOWN") return { kind: "anchorGone" };
  if (code === "FINDING_PURGED") return { kind: "purged" };
  if (code === "UNPROCESSABLE" && detail.failure === "PARSE") return { kind: "unreadable" };
  if (code === "RESEARCH_UNAVAILABLE") return { kind: "unconfigured" };
  const resetsAt = text(detail.resetsAt);
  if (code === "RESEARCH_SENDS_LIMIT" && resetsAt !== null) return { kind: "sendsLimit", resetsAt };
  const until = text(detail.throttledUntil);
  if (code === "SUGGESTION_THROTTLED" && until !== null) return { kind: "throttled", until };
  return { kind: "unavailable" };
}
