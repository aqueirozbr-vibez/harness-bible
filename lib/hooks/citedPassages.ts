"use client";

/*
 * What the open answer cites, from the dock to the reading column beside it (feature-specs/16 § 7). The two are
 * different React trees — the dock is a parallel slot — so they speak through a window event, as the figures table
 * and the prose already do (`hb:figure`).
 *
 * The detail is the citations of the newest answer and nothing else: the column highlights the paragraphs that print
 * the figures they name, and clears them when the dock closes.
 */

export const CITED_EVENT = "hb:cited";

export interface CitedCitation {
  readonly sectionId: string;
  readonly figureId: string | null;
}

export interface CitedDetail {
  readonly citations: ReadonlyArray<CitedCitation>;
}

export function dispatchCited(detail: CitedDetail): void {
  window.dispatchEvent(new CustomEvent<CitedDetail>(CITED_EVENT, { detail }));
}

/** The status bar's assistant cells, from the dock: the mode, whether a turn is running, the last first-token time. */
export const ASSISTANT_STATUS_EVENT = "hb:assistant";

export interface AssistantStatusDetail {
  readonly mode: string;
  readonly answering: boolean;
  readonly firstTokenMs: number | null;
  /** A walk turn on screen (feature-specs/18 § 5.3): its aid, where its strip stands, and the run's duration once it has one. */
  readonly walk: { readonly aidId: string; readonly step: number; readonly of: number; readonly runMs: number | null } | null;
}

export function dispatchAssistantStatus(detail: AssistantStatusDetail): void {
  window.dispatchEvent(new CustomEvent<AssistantStatusDetail>(ASSISTANT_STATUS_EVENT, { detail }));
}
