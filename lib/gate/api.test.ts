import { describe, expect, it } from "vitest";

import { sseEvent } from "@/lib/api/sse";

import { sseEventsOf } from "./api";

/*
 * The gate reads the assistant's stream as the dock does: frames, each an id, an event and its data. The turns
 * themselves are tests/integration/gate-turns.test.ts, which needs the database and the policy sidecar.
 */

describe("a stream's body as its events", () => {
  it("reads back the frames the API writes, in order", () => {
    const body = [sseEvent("1", "meta", { messageId: "m", traceId: "t" }), sseEvent("2", "token", { text: 'a "quoted" delta\nwith a line break' }), sseEvent("3", "final", { kind: "answer", claims: [] })].join("");
    expect(sseEventsOf(body)).toEqual([
      { id: "1", event: "meta", data: { messageId: "m", traceId: "t" } },
      { id: "2", event: "token", data: { text: 'a "quoted" delta\nwith a line break' } },
      { id: "3", event: "final", data: { kind: "answer", claims: [] } },
    ]);
  });

  it("leaves out the keep-alive comment and an empty frame, and reads a frame without data as an empty object", () => {
    expect(sseEventsOf(": keep-alive\n\n\n\nid: 7\nevent: status\ndata: {\"step\":\"drafting\"}\n\n: keep-alive\n\n")).toEqual([{ id: "7", event: "status", data: { step: "drafting" } }]);
    expect(sseEventsOf("event: final\n\n")).toEqual([{ id: "", event: "final", data: {} }]);
    expect(sseEventsOf("")).toEqual([]);
  });

  it("does not throw on data that is not JSON or not an object: the event is kept, its data empty", () => {
    expect(sseEventsOf("id: 1\nevent: token\ndata: {not json\n\n")).toEqual([{ id: "1", event: "token", data: {} }]);
    expect(sseEventsOf("id: 1\nevent: token\ndata: 42\n\n")).toEqual([{ id: "1", event: "token", data: {} }]);
  });
});
