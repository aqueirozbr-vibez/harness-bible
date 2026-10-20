import type { NewResearchStep, ResearchStepPatch, RunRef } from "@/lib/db/research";
import { toolEventOf } from "@/lib/gateway/tools";

/*
 * A person's run's live steps from the reader's stream (feature-specs/48 § 6; unit 70b). The reader's turn tells
 * `onBlock` each content block as the stream completes it (lib/gateway/turn.ts), and a search or a fetch is a step twice
 * over, milliseconds apart: appended when its `server_tool_use` block completes, completed when its result arrives.
 * The SDK's listeners are synchronous and not awaited, so every write goes on one promise chain, in the blocks' order,
 * and the chain is awaited before the read step stores what the reader found. Each write is one statement of the door
 * (`appendRunStep`, `completeRunStep`, lib/db/research.ts), never a read-modify-write of the array. A write that fails
 * is logged and never fails the read; every block heartbeats. A step is progress, not evidence, and never part of the
 * workflow's history (invariant 35): the activity writes the row.
 */

/** What a block means for the steps: a step appended for a tool's use, or the use's step completed by its result; null for a block that is no step. */
export type StepAction = { readonly kind: "append"; readonly toolUseId: string; readonly step: NewResearchStep } | { readonly kind: "complete"; readonly toolUseId: string; readonly patch: ResearchStepPatch };

/** The step a block makes, pure: a search with its query, a page with the address asked; then the search's count of results, the page opened with its title, or the page not reached. A use with no query or address is no step. */
export function stepActionOf(block: unknown, at: string): StepAction | null {
  const event = toolEventOf(block);
  if (event === null) return null;
  switch (event.kind) {
    case "search":
      return event.query === null || event.query.trim().length === 0 ? null : { kind: "append", toolUseId: event.toolUseId, step: { kind: "SEARCH", at, query: event.query, results: null } };
    case "fetch":
      return event.requested === null || event.requested.trim().length === 0 ? null : { kind: "append", toolUseId: event.toolUseId, step: { kind: "PAGE", at, url: event.requested, title: null, opened: null } };
    case "searched":
      return { kind: "complete", toolUseId: event.toolUseId, patch: { results: event.results } };
    case "fetched":
      return { kind: "complete", toolUseId: event.toolUseId, patch: event.opened === null ? { opened: false } : { url: event.opened, title: event.title, opened: true } };
  }
}

export interface StepQueueDeps {
  readonly append: (run: RunRef, step: NewResearchStep) => Promise<number | null>;
  readonly complete: (run: RunRef, seq: number, patch: ResearchStepPatch) => Promise<boolean>;
  /** The activity's heartbeat (48 § 5.1): every block is one. */
  readonly heartbeat: () => void;
  readonly log: (line: string) => void;
  readonly now: () => Date;
}

export interface StepQueue {
  /** The reader's `onBlock`: synchronous, as the SDK calls it; the write goes on the chain. */
  readonly onBlock: (block: unknown) => void;
  /** Settles when every write handed to the chain has been made or has failed and been logged; never rejects. */
  readonly settled: () => Promise<void>;
}

/** The one ordered chain of a read's step writes (48 § 6). A completion whose step was not written — it failed, or the text went — is skipped. */
export function stepQueue(run: RunRef & { readonly traceId: string }, deps: StepQueueDeps): StepQueue {
  let chain: Promise<void> = Promise.resolve();
  const seqOf = new Map<string, number>();
  const write = async (action: StepAction): Promise<void> => {
    if (action.kind === "append") {
      const seq = await deps.append(run, action.step);
      if (seq !== null) seqOf.set(action.toolUseId, seq);
      return;
    }
    const seq = seqOf.get(action.toolUseId);
    if (seq !== undefined) await deps.complete(run, seq, action.patch);
  };
  return {
    onBlock: (block) => {
      deps.heartbeat();
      const action = stepActionOf(block, deps.now().toISOString());
      if (action === null) return;
      chain = chain
        .then(() => write(action))
        .catch((error: unknown) => {
          deps.log(`research ${run.id}: a live step was not written (${error instanceof Error ? error.name : "unknown"}); the read goes on (trace ${run.traceId})`);
        });
    },
    settled: () => chain,
  };
}
