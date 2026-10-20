import type { SuggestionView } from "@/lib/schemas/suggestions";

/*
 * What the edit page's islands tell one another about the draft (feature-specs/34 § 5, § 6; unit 51e), as a save
 * tells the class panel (draftSave.ts): a fresh view of the draft — the evidence list's read, a save's answer — which
 * the score column draws, so that every number on it is the server's; the rationale's words, which Submit waits on;
 * a request to save now (`Save draft`); and a submission's refusal, which the field it concerns shows.
 */

export const DRAFT_VIEW_EVENT = "hb:draft-view";
export const DRAFT_WORDS_EVENT = "hb:draft-words";
export const DRAFT_FLUSH_EVENT = "hb:draft-flush";
export const DRAFT_STOP_EVENT = "hb:draft-stop";
export const SUBMIT_REFUSED_EVENT = "hb:submit-refused";

function listen<T>(name: string, listener: (detail: T) => void): () => void {
  const handle = (event: Event): void => listener((event as CustomEvent<T>).detail);
  window.addEventListener(name, handle);
  return () => window.removeEventListener(name, handle);
}

export function dispatchDraftView(view: SuggestionView): void {
  window.dispatchEvent(new CustomEvent<SuggestionView>(DRAFT_VIEW_EVENT, { detail: view }));
}

/** Listen for fresh views of the draft on this page; the returned function stops listening. */
export function onDraftView(listener: (view: SuggestionView) => void): () => void {
  return listen(DRAFT_VIEW_EVENT, listener);
}

/** The rationale as it stands in its field, saved or not: its words, and whether they pass the most a rationale may have. */
export interface DraftWords {
  readonly words: number;
  readonly over: boolean;
}

export function dispatchDraftWords(detail: DraftWords): void {
  window.dispatchEvent(new CustomEvent<DraftWords>(DRAFT_WORDS_EVENT, { detail }));
}

export function onDraftWords(listener: (detail: DraftWords) => void): () => void {
  return listen(DRAFT_WORDS_EVENT, listener);
}

/** `Save draft`: every field saves what it has now, without the pause. */
export function requestDraftFlush(): void {
  window.dispatchEvent(new CustomEvent<null>(DRAFT_FLUSH_EVENT, { detail: null }));
}

export function onDraftFlush(listener: () => void): () => void {
  return listen<null>(DRAFT_FLUSH_EVENT, () => listener());
}

/** The draft is gone (`Delete draft`, feature-specs/45 § 4): every field's autosave sends nothing more, not even on leaving. */
export function requestDraftStop(): void {
  window.dispatchEvent(new CustomEvent<null>(DRAFT_STOP_EVENT, { detail: null }));
}

export function onDraftStop(listener: () => void): () => void {
  return listen<null>(DRAFT_STOP_EVENT, () => listener());
}

/** A submission the server refused, with the code that names what it concerns, its words and the sensor's own. */
export interface SubmitRefused {
  readonly code: string;
  readonly message: string;
  /** The sensor's own sentence, for an intake refusal (`INTAKE_*`); null for every other. */
  readonly detail: string | null;
  readonly traceId: string | null;
}

export function dispatchSubmitRefused(detail: SubmitRefused | null): void {
  window.dispatchEvent(new CustomEvent<SubmitRefused | null>(SUBMIT_REFUSED_EVENT, { detail }));
}

/** Null when a new submission starts, which clears what the last one left. */
export function onSubmitRefused(listener: (detail: SubmitRefused | null) => void): () => void {
  return listen(SUBMIT_REFUSED_EVENT, listener);
}
