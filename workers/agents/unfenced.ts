/*
 * A Markdown code fence is not a failure of an answer. `claude-opus-5` returns the JSON object a guide asks for inside a
 * ```json block (measured 2026-10-03 on every real turn: the assistant's drafts and the grader's scores alike, every one
 * of them valid JSON inside the fence), so both parsers take the fence off before they read, and hold what is inside it
 * to the schema exactly as before. Text that carries no fence comes back as it came.
 */

/** The text without a code fence around it. The opening fence runs to its line's end (```json, ```); the closing one is the last three characters. */
export function unfenced(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```") || trimmed.length < 6) return trimmed;
  const firstBreak = trimmed.indexOf("\n");
  if (firstBreak < 0) return trimmed;
  return trimmed.slice(firstBreak + 1, trimmed.length - 3).trim();
}

/**
 * The JSON object inside prose: from the first `{` (or `[`) to the last matching `}` (or `]`). The guide says text
 * outside the structure is discarded, and this is where it is discarded — a draft that opens with a heading and then
 * gives the object is the object (measured on the first real walks, 2026-10-03: both drafts began `**Walk of …` and
 * bought the repair pass). Text with no bracket at all comes back as it came, so `JSON.parse` names the failure.
 */
export function jsonBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  const open = trimmed.search(/[{[]/);
  if (open < 0) return trimmed;
  const close = trimmed.lastIndexOf(trimmed[open] === "{" ? "}" : "]");
  if (close <= open) return trimmed;
  return trimmed.slice(open, close + 1);
}
