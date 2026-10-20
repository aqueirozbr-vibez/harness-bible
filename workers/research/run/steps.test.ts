import { describe, expect, it } from "vitest";

import type { NewResearchStep, ResearchStepPatch } from "@/lib/db/research";

import { stepActionOf, stepQueue } from "./steps";

/*
 * A person's run's live steps from the reader's stream (feature-specs/48 § 6; unit 70b): each tool block as the step it
 * makes; the one ordered chain of one-statement writes, a search appended then completed in the blocks' order however
 * slow a write is; a completion whose step was not written skipped; a write that fails logged and never thrown; each
 * block a heartbeat.
 */

const AT = "2026-10-12T10:00:00.000Z";
const RUN = { id: "33333333-3333-4333-8333-333333333333", userId: "55555555-5555-4555-8555-555555555555", traceId: "f".repeat(32) };
const SEARCH = { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "idempotency key retention" } };
const SEARCHED = { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://standards.example/keys", title: "Keys" }, { type: "web_search_result", url: "https://forum.example/t/1", title: "Forum" }] };
const FETCH = { type: "server_tool_use", id: "f1", name: "web_fetch", input: { url: "https://standards.example/keys" } };
const FETCHED = { type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_result", url: "https://standards.example/keys/2026", content: { type: "document", title: "Keys, 2026" } } };

describe("stepActionOf", () => {
  it("appends a search with its query and a page with the address asked; completes them with the count of results, the page opened and its title, or not reached", () => {
    expect(stepActionOf(SEARCH, AT)).toEqual({ kind: "append", toolUseId: "s1", step: { kind: "SEARCH", at: AT, query: "idempotency key retention", results: null } });
    expect(stepActionOf(SEARCHED, AT)).toEqual({ kind: "complete", toolUseId: "s1", patch: { results: 2 } });
    expect(stepActionOf(FETCH, AT)).toEqual({ kind: "append", toolUseId: "f1", step: { kind: "PAGE", at: AT, url: "https://standards.example/keys", title: null, opened: null } });
    expect(stepActionOf(FETCHED, AT)).toEqual({ kind: "complete", toolUseId: "f1", patch: { url: "https://standards.example/keys/2026", title: "Keys, 2026", opened: true } });
    expect(stepActionOf({ type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } }, AT)).toEqual({ kind: "complete", toolUseId: "f1", patch: { opened: false } });
  });

  it("makes no step of a text block, a use with no query or address, or a block of another kind", () => {
    expect(stepActionOf({ type: "text", text: "{}" }, AT)).toBeNull();
    expect(stepActionOf({ type: "server_tool_use", id: "s2", name: "web_search", input: {} }, AT)).toBeNull();
    expect(stepActionOf({ type: "server_tool_use", id: "s3", name: "web_search", input: { query: "  " } }, AT)).toBeNull();
    expect(stepActionOf({ type: "thinking", thinking: "…" }, AT)).toBeNull();
  });
});

describe("stepQueue", () => {
  function queue(over: { readonly append?: (step: NewResearchStep) => Promise<number | null>; readonly complete?: (seq: number, patch: ResearchStepPatch) => Promise<boolean> } = {}) {
    const writes: string[] = [];
    const logged: string[] = [];
    let heartbeats = 0;
    let seq = 0;
    const steps = stepQueue(RUN, {
      append:
        over.append === undefined
          ? async (_run, step) => {
              /* the first append is slow: its completion must still come after it */
              await new Promise((resolve) => setTimeout(resolve, step.kind === "SEARCH" ? 20 : 0));
              writes.push(`append:${step.kind}`);
              return seq++;
            }
          : (_run, step) => over.append?.(step) ?? Promise.resolve(null),
      complete:
        over.complete === undefined
          ? async (_run, at, patch) => {
              writes.push(`complete:${String(at)}:${JSON.stringify(patch)}`);
              return true;
            }
          : (_run, at, patch) => over.complete?.(at, patch) ?? Promise.resolve(false),
      heartbeat: () => {
        heartbeats += 1;
      },
      log: (line) => logged.push(line),
      now: () => new Date(AT),
    });
    return { steps, writes, logged, heartbeats: () => heartbeats };
  }

  it("writes each block's step in the blocks' order through one chain, a completion after its append however slow that was, and settles once all are written", async () => {
    const run = queue();
    for (const block of [SEARCH, SEARCHED, FETCH, { type: "text", text: "{}" }, FETCHED]) run.steps.onBlock(block);
    expect(run.writes).toEqual([]);
    await run.steps.settled();
    expect(run.writes).toEqual(["append:SEARCH", 'complete:0:{"results":2}', "append:PAGE", 'complete:1:{"url":"https://standards.example/keys/2026","title":"Keys, 2026","opened":true}']);
    expect(run.heartbeats()).toBe(5);
  });

  it("skips a completion whose step was not written, and logs a write that failed without failing the read", async () => {
    const completed: number[] = [];
    const run = queue({
      append: async (step) => {
        if (step.kind === "SEARCH") throw new Error("the database is away");
        return null;
      },
      complete: async (seq) => {
        completed.push(seq);
        return true;
      },
    });
    for (const block of [SEARCH, SEARCHED, FETCH, FETCHED]) run.steps.onBlock(block);
    await expect(run.steps.settled()).resolves.toBeUndefined();
    expect(completed).toEqual([]);
    expect(run.logged).toEqual([expect.stringContaining("a live step was not written (Error)")]);
    expect(run.logged.join("\n")).not.toContain("database");
  });
});
